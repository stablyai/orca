import { beforeEach } from 'vitest'
import { setSecretStore } from '../../src/shared/secret-store'

/**
 * Why: `getSecretStore()` throws until an entrypoint installs a store, which is the
 * right production behaviour but would fail ~67 suites that only ever cared that
 * *some* store existed. Install a reversible in-memory one before every test so
 * those suites stay unchanged; a suite that asserts on sealing behaviour calls
 * `setSecretStore()` itself and wins, because this runs first.
 *
 * Deliberately not a plaintext passthrough: encryptString must return something a
 * test can tell apart from the input, or a test that forgot to seal would pass.
 */
const SEAL_PREFIX = 'vitest-sealed:'

beforeEach(() => {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`${SEAL_PREFIX}${plainText}`),
    decryptString: (cipher) => {
      const text = cipher.toString()
      if (!text.startsWith(SEAL_PREFIX)) {
        throw new Error('vitest secret store: ciphertext was not produced by this store')
      }
      return text.slice(SEAL_PREFIX.length)
    },
    describeUnavailable: () => null
  })
})
