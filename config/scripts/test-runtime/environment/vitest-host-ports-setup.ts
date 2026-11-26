import process from 'node:process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach } from 'vitest'
import {
  setAppEnvironment,
  type AppEnvironment
} from '../../../../src/shared/app-lifecycle/app-environment'
import { errnoCodeOrUnknown } from '../../../../src/shared/errors/errno-code'
import { setSecretStore } from '../../../../src/shared/secure-storage/secret-store'

// The harness owns its directory even when a suite replaces the fs module.
const { mkdtempSync, rmSync } = process.getBuiltinModule('fs')

// Install benign host ports before tests; production correctly throws before entry installs them, while suites can override defaults afterward.

// Most suites never read a host data path; create its per-file directory only when needed.
let userData: string | undefined

function userDataPath(): string {
  return (userData ??= mkdtempSync(join(tmpdir(), 'orca-vitest-userdata-')))
}

afterAll(async () => {
  if (userData) {
    // Suites that route through the structured agent-session host install its
    // process-wide record-store slot against userData; retire it so the
    // worker-owned journal releases the database files before removal.
    try {
      const slot =
        await import('../../../../src/main/runtime/agent-session/records/agent-session-record-store-slot')
      await slot.retireAgentSessionRecordStore((opened) =>
        slot.closeAgentSessionRecordStoreDatabase(opened?.journalDatabase)
      )
    } catch (error) {
      console.log(`vitest userdata teardown: record-store retire skipped (${String(error)})`)
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(userData, { recursive: true, force: true })
        return
      } catch (error) {
        if (
          attempt >= 16 ||
          process.platform !== 'win32' ||
          !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(errnoCodeOrUnknown(error))
        ) {
          throw error
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
      }
    }
  }
})

// Return ciphertext distinct from input so forgotten sealing cannot pass.
const SEAL_PREFIX = 'vitest-sealed:'

// Let suites specify only relevant fake-host members rather than duplicate entire environment.
export function fakeAppEnvironment(overrides: Partial<AppEnvironment> = {}): AppEnvironment {
  return {
    getPath: (name) => {
      if (name === 'home') {
        return homedir()
      }
      if (name === 'temp') {
        return tmpdir()
      }
      return userDataPath()
    },
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
