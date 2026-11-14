import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from './persistence-test-harness'
// Random-IV ciphertext changes on every encryption; identical state must still skip redundant writes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

// Random IVs exercise write skipping; deterministic mode exposes collisions with user-controlled fields.
const cipherState = { encryptionAvailable: true, deterministic: false }
const DETERMINISTIC_IV = 'd'.repeat(36)

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

vi.mock('../telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => cipherState.encryptionAvailable,
    encryptString: (plaintext) =>
      Buffer.from(
        `enc:${cipherState.deterministic ? DETERMINISTIC_IV : randomUUID()}:${plaintext}`,
        'utf-8'
      ),
    decryptString: (ciphertext) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    },
    describeProtectionGap: () => null
  })
  const { Store } = await import('./loading-store/store')
  const { initDataPath } = await import('./loading-store/user-data-path')
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

describe('persistence single-serialize save guard', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    cipherState.encryptionAvailable = true
    cipherState.deterministic = false
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('retains the stored ciphertext across repeated synchronous complete saves and protection recovery', async () => {
    const store = await createStore()
    store.updateSettings({ opencodeSessionCookie: 'synthetic-cookie' })
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    const first = JSON.parse(readPersistedStateJson(dataFile())).settings.opencodeSessionCookie
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    expect(JSON.parse(readPersistedStateJson(dataFile())).settings.opencodeSessionCookie).toBe(
      first
    )
    cipherState.encryptionAvailable = false
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    expect(JSON.parse(readPersistedStateJson(dataFile())).settings.opencodeSessionCookie).toBe(
      first
    )
    cipherState.encryptionAvailable = true
    store.getWorkspaceSession().activeTabId = 'getter-change'
    await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
    expect(JSON.parse(readPersistedStateJson(dataFile())).workspaceSession.activeTabId).toBe(
      'getter-change'
    )
    expect((await createStore()).getSettings().opencodeSessionCookie).toBe('synthetic-cookie')
  })

  // Ciphertext can equal a user-controlled value; value-based normalization could hash distinct states equally.
  it('persists a swap between a plaintext field and a secret when the plaintext equals the secret ciphertext (deterministic cipher)', async () => {
    cipherState.deterministic = true
    const store = await createStore()

    const P = 'cookie-plaintext-value'
    store.updateSettings({ opencodeSessionCookie: P })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const C: string = JSON.parse(readPersistedStateJson(dataFile())).settings.opencodeSessionCookie
    expect(C).not.toBe(P)

    // Place the same ciphertext in a non-secret field to expose value-based substitution.
    store.updateSettings({ httpProxyBypassRules: C, opencodeSessionCookie: P })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const inoState1 = readPersistedStateJson(dataFile())

    // Swap values without changing their textual occurrences; this must still write.
    store.updateSettings({ httpProxyBypassRules: P, opencodeSessionCookie: C })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(readPersistedStateJson(dataFile())).not.toBe(inoState1)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(P)
    expect(reloaded.getSettings().opencodeSessionCookie).toBe(C)
  })

  // User-controlled JSON keys can mimic secret slots; key-based replacement must not normalize the wrong field.
})
