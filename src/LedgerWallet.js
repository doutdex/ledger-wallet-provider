import ledger from 'ledgerco/src/index-browserify';
import EthereumTx from 'ethereumjs-tx';
require('./u2f-api');

const NOT_SUPPORTED_ERROR_MSG =
    "LedgerWallet uses U2F which is not supported by your browser. " +
    "Use Chrome, Opera or Firefox with a U2F extension." +
    "Also make sure you're on an HTTPS connection";
/**
 *  @class LedgerWallet
 *
 *
 *  Paths:
 *  Minimum Nano Ledger S accepts are:
 *
 *   * 44'/60'
 *   * 44'/61'
 *
 *  MyEtherWallet.com by default uses the range
 *
 *   * 44'/60'/0'/n
 *
 *  Note: no hardend derivation on the `n`
 *
 *  BIP44/EIP84 specificies:
 *
 *  * m / purpose' / coin_type' / account' / change / address_index
 *
 *  @see https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki
 *  @see https://github.com/satoshilabs/slips/blob/master/slip-0044.md
 *  @see https://github.com/MetaMask/provider-engine
 *  @see https://github.com/ethereum/wiki/wiki/JavaScript-API
 *
 *  Implementations:
 *  https://github.com/MetaMask/metamask-plugin/blob/master/app/scripts/keyrings/hd.js
 *
 */
class LedgerWallet {
    constructor() {
        this._path = "44'/60'/0'/0";
        this._accounts = undefined;
        this.isU2FSupported = null;
        this.getAppConfig = this.getAppConfig.bind(this);
        this.getAccounts = this.getAccounts.bind(this);
        this.signTransaction = this.signTransaction.bind(this);
    }

    async init() {
        this.isU2FSupported = await LedgerWallet.isSupported();
    }

    /**
     * Checks if the browser supports u2f.
     * Currently there is no good way to do feature-detection,
     * so we call getApiVersion and wait for 100ms
     */
    static async isSupported() {
        return new Promise((resolve, reject) => {
            if (window.u2f) {
                // u2f object is found (Firefox with extension)
                resolve(true);
            } else {
                // u2f object was not found. Using Google polyfill
                const intervalId = setTimeout(() => {
                    resolve(false);
                }, 3000);
                window.u2f.getApiVersion((version) => {
                    clearTimeout(intervalId);
                    resolve(true);
                });
            }
        });
    };

    async _getLedgerConnection() {
        return new ledger.eth(await ledger.comm_u2f.create_async());
    }

    async _closeLedgerConnection(eth) {
        eth.comm.close_async()
    }

    /**
     @typedef {function} failableCallback
     @param error
     @param result
     */

    /**
     * Gets the version of installed ethereum app
     * Check the isSupported() before calling that function
     * otherwise it never returns
     * @param {failableCallback} callback
     */
     getAppConfig(callback) {
        if (!this.isU2FSupported) {
            callback(new Error(NOT_SUPPORTED_ERROR_MSG));
            return;
        }
        let eth = this._getLedgerConnection();
        let cleanupCallback = (error, data) => {
            this._closeLedgerConnection(eth);
            callback(error, data);
        };
        eth.getAppConfiguration_async()
            .then(config => cleanupCallback(null, config))
            .catch(error => cleanupCallback(error))
    }

    /**
     * Gets a list of accounts from a device
     * @param {failableCallback} callback
     * @param askForOnDeviceConfirmation
     */
    getAccounts(callback, askForOnDeviceConfirmation = true) {
        if (!this.isU2FSupported) {
            callback(new Error(NOT_SUPPORTED_ERROR_MSG));
            return;
        }
        if (this._accounts !== undefined) {
            callback(null, this._accounts);
            return;
        }
        const chainCode = false; // Include the chain code
        let eth = this._getLedgerConnection();
        let cleanupCallback = (error, data) => {
            this._closeLedgerConnection(eth);
            callback(error, data);
        };
        this.eth.getAddress_async(this._path, askForOnDeviceConfirmation, chainCode)
            .then(result => {
                this._accounts = [result.address.toLowerCase()];
                cleanupCallback(null, this._accounts);
            })
            .catch(error => cleanupCallback(error));
    }

    /**
     * Signs txData in a format that ethereumjs-tx accepts
     * @param {object} txData - transaction to sign
     * @param {failableCallback} callback - callback
     */
    signTransaction(txData, callback) {
        if (!this.isU2FSupported) {
            callback(new Error(NOT_SUPPORTED_ERROR_MSG));
            return;
        }
        // Encode using ethereumjs-tx
        let tx = new EthereumTx(txData);

        // Fetch the chain id
        web3.version.getNetwork((error, chain_id) => {
            if (error) callback(error);

            // Force chain_id to int
            chain_id = 0 | chain_id;

            // Set the EIP155 bits
            tx.raw[6] = Buffer.from([chain_id]); // v
            tx.raw[7] = Buffer.from([]);         // r
            tx.raw[8] = Buffer.from([]);         // s

            // Encode as hex-rlp for Ledger
            const hex = tx.serialize().toString("hex");

            let eth = this._getLedgerConnection();
            let cleanupCallback = (error, data) => {
                this._closeLedgerConnection(eth);
                callback(error, data);
            };
            // Pass to _ledger for signing
            eth.signTransaction(this._path, hex)
                .then(result => {
                    // Store signature in transaction
                    tx.v = new Buffer(result.v, "hex");
                    tx.r = new Buffer(result.r, "hex");
                    tx.s = new Buffer(result.s, "hex");

                    // EIP155: v should be chain_id * 2 + {35, 36}
                    const signed_chain_id = Math.floor((tx.v[0] - 35) / 2);
                    if (signed_chain_id !== chain_id) {
                        cleanupCallback("Invalid signature received. Please update your Ledger Nano S.");
                    }

                    // Return the signed raw transaction
                    const rawTx = "0x" + tx.serialize().toString("hex");
                    cleanupCallback(undefined, rawTx);
                })
                .catch(error => cleanupCallback(error))
        })
    }
}

module.exports = LedgerWallet;