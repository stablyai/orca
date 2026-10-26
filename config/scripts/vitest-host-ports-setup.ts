import process from 'node:process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../src/shared/app-environment'
import { setSecretStore } from '../../src/shared/secret-store'

// The harness owns its directory even when a suite replaces the fs module.
const { mkdtempSync, rmSync } = process.getBuiltinModule('fs')

// Install benign host ports before tests; production correctly throws before entry installs them, while suites can override defaults afterward.

// Most suites never read a host data path; create its per-file directory only when needed.
let userData: string | undefined

function userDataPath(): string {
  return (userData ??= mkdtempSync(join(tmpdir(), 'orca-vitest-userdata-')))
}

afterAll(() => {
  if (userData) {
    rmSync(userData, { recursive: true, force: true })
  }
})

// Return ciphertext distinct from input so forgotten sealing cannot pass.
const SEAL_PREFIX = 'vitest-sealed:'

// Let suites specify only relevant fake-host members rather than duplicate entire environment.
export function fakeAppEnvironment(overrides: Partial<AppEnvironment> = {}): AppEnvironment {
  return {
    getPath: (name) => (name === 'home' ? homedir() : name === 'temp' ? tmpdir() : userDataPath()),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => [],
    ...overrides
  }
}

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
