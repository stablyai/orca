import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../src/shared/app-environment'
import { setSecretStore } from '../../src/shared/secret-store'

/**
 * Why: both host ports throw until an entrypoint installs them, which is the right
 * production behaviour but would fail ~70 suites that only ever needed *some* host.
 * Install benign defaults before every test so those suites stay unchanged; a suite
 * that asserts on host behaviour installs its own and wins, because this runs first.
 */

// One directory per test environment, not per test: suites that write a file in one
// step and read it back in the next would otherwise lose it between them. Removed on
// teardown — vitest builds one environment per test file, so without this a full run
// leaves thousands of directories behind.
const userData = mkdtempSync(join(tmpdir(), 'orca-vitest-userdata-'))

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

// Deliberately not a plaintext passthrough: encryptString must return something a
// test can tell apart from its input, or a test that forgot to seal would pass.
const SEAL_PREFIX = 'vitest-sealed:'

/**
 * Build a fake environment from just the members a suite cares about. Exported so
 * suites that need a specific path or metrics fixture state only that, instead of
 * restating all seven members — which is boilerplate, and pushed one suite past
 * the max-lines budget.
 */
export function fakeAppEnvironment(overrides: Partial<AppEnvironment> = {}): AppEnvironment {
  return {
    getPath: (name) => (name === 'home' ? homedir() : name === 'temp' ? tmpdir() : userData),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => [],
    ...overrides
  }
}

/** Install a fake in one call — the common shape in suites that need one specific member. */
export function installFakeAppEnvironment(overrides: Partial<AppEnvironment> = {}): void {
  setAppEnvironment(fakeAppEnvironment(overrides))
}

beforeEach(() => {
  setAppEnvironment(fakeAppEnvironment())
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
    describeProtectionGap: () => null
  })
})
