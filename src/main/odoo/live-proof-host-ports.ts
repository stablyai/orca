import { setMainHttpClient } from '../network/http-client'
import { setSecretStore } from '../../shared/secret-store'

/**
 * Installs the plain-Node host ports the opt-in Odoo live proofs need.
 *
 * The Odoo modules reach outbound HTTP through `MainHttpClient` and at-rest
 * encryption through `SecretStore` rather than importing `electron`, so a proof
 * running under vitest has to supply both. A disposable proof instance is called
 * directly: no Chromium proxy session, and no keychain.
 */
export function installOdooLiveProofHostPorts(): void {
  setMainHttpClient({
    fetch: (url, init) => globalThis.fetch(url, init),
    proxySession: () => null
  })
  // Encryption reported unavailable, matching the safeStorage double these proofs
  // used before: the API key round-trips as plaintext in the credential file.
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: (plainText) => Buffer.from(plainText),
    decryptString: (cipher) => cipher.toString(),
    describeProtectionGap: () => null
  })
}
