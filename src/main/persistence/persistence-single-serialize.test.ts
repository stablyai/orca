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
import { ProfileStateSqliteAuthority } from './profile-state/profile-state-sqlite-authority'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

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

function persistedRevision(): number {
  const reader = new ProfileStateSqliteAuthority(
    join(testState.dir, 'profile-state.db'),
    'persistence-test'
  )
  try {
    reader.readSerializedState()
    return reader.revision
  } finally {
    reader.close()
  }
}

const SECRETS = {
  opencodeSessionCookie: 'cookie-$&-value',
  httpProxyUrl: 'http://user:p@ss@proxy.local:8080'
} as const
const KAGI_LINK = 'https://kagi.com/session?token=abc123'

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

  async function seedStoreWithSecrets() {
    const store = await createStore()
    store.updateSettings({ ...SECRETS })
    store.updateUI({ browserKagiSessionLink: KAGI_LINK })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    return store
  }

  it('skips the disk write when state is identical, even with secrets set (random-IV cipher)', async () => {
    const store = await seedStoreWithSecrets()
    const stateBefore = readPersistedStateJson(dataFile())
    const revisionBefore = persistedRevision()

    // Net no-op state must hash identically despite random-IV encryption.
    const originalWidth = store.getUI().sidebarWidth
    store.updateUI({ sidebarWidth: 512 })
    store.updateUI({ sidebarWidth: originalWidth })
    store.updateSettings({ ...SECRETS })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()

    expect(readPersistedStateJson(dataFile())).toBe(stateBefore)
    expect(persistedRevision()).toBe(revisionBefore)
  })

  it('still writes when state actually changes (including a secret change)', async () => {
    const store = await seedStoreWithSecrets()
    const stateBefore = readPersistedStateJson(dataFile())

    store.updateSettings({ opencodeSessionCookie: 'rotated-cookie' })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const stateAfter = readPersistedStateJson(dataFile())
    expect(stateAfter).not.toBe(stateBefore)

    store.updateUI({ sidebarWidth: 777 })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(readPersistedStateJson(dataFile())).not.toBe(stateAfter)
  })

  it('writes encrypted secrets to disk and round-trips them through a reload', async () => {
    await seedStoreWithSecrets()

    const raw = readPersistedStateJson(dataFile())
    const persisted = JSON.parse(raw) as {
      settings: { opencodeSessionCookie: string; httpProxyUrl: string }
      ui: { browserKagiSessionLink: string }
    }
    expect(persisted.settings.opencodeSessionCookie).not.toBe(SECRETS.opencodeSessionCookie)
    expect(persisted.settings.httpProxyUrl).not.toBe(SECRETS.httpProxyUrl)
    expect(persisted.ui.browserKagiSessionLink).not.toBe(KAGI_LINK)
    expect(raw).not.toContain(SECRETS.opencodeSessionCookie)
    expect(raw).not.toContain(KAGI_LINK)

    const reloaded = await createStore()
    expect(reloaded.getSettings().opencodeSessionCookie).toBe(SECRETS.opencodeSessionCookie)
    expect(reloaded.getSettings().httpProxyUrl).toBe(SECRETS.httpProxyUrl)
    expect(reloaded.getUI().browserKagiSessionLink).toBe(KAGI_LINK)
  })

  it('omits new secrets when encryption is unavailable and still skips an identical state', async () => {
    cipherState.encryptionAvailable = false
    const store = await createStore()
    store.updateSettings({ ...SECRETS, opencodeSessionCookie: '' })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { opencodeSessionCookie: string; httpProxyUrl: string }
    }
    expect(persisted.settings.opencodeSessionCookie).toBe('')
    expect(persisted.settings.httpProxyUrl).toBe('')

    const stateBefore = readPersistedStateJson(dataFile())
    const revisionBefore = persistedRevision()
    store.updateSettings({ httpProxyUrl: SECRETS.httpProxyUrl })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(readPersistedStateJson(dataFile())).toBe(stateBefore)
    expect(persistedRevision()).toBe(revisionBefore)
  })

  it('sync flush also skips on identical state with secrets set', async () => {
    const store = await seedStoreWithSecrets()
    const stateBefore = readPersistedStateJson(dataFile())
    const revisionBefore = persistedRevision()

    store.flushOrThrow()

    expect(readPersistedStateJson(dataFile())).toBe(stateBefore)
    expect(persistedRevision()).toBe(revisionBefore)
  })

  it('does not serialize the complete profile for a UI domain save', async () => {
    const store = await seedStoreWithSecrets()

    // Only full durable-state payloads exceed this size threshold in the save path.
    const original = JSON.stringify.bind(JSON)
    let fullStateSerializations = 0
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
      const [value] = args
      const out = original(...args)
      if (
        value &&
        typeof value === 'object' &&
        'repos' in value &&
        'settings' in value &&
        'ui' in value
      ) {
        fullStateSerializations++
      }
      return out
    })
    try {
      store.updateUI({ sidebarWidth: 640 })
      vi.advanceTimersByTime(2000)
      await store.waitForPendingWrite()
    } finally {
      spy.mockRestore()
    }

    expect(fullStateSerializations).toBe(0)
    const reloaded = await createStore()
    expect(reloaded.getUI().sidebarWidth).toBe(640)
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
  it('persists a swap when an agentDefaultEnv var is named after a secret field and holds its ciphertext (deterministic cipher)', async () => {
    cipherState.deterministic = true
    const store = await createStore()

    const K = 'https://kagi.com/session?token=SECRET'
    store.updateUI({ browserKagiSessionLink: K })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    const C: string = JSON.parse(readPersistedStateJson(dataFile())).ui.browserKagiSessionLink
    expect(C).not.toBe(K)

    // Place ciphertext under a secret-like key in a non-secret environment map.
    store.updateSettings({ agentDefaultEnv: { claude: { browserKagiSessionLink: C } } })
    store.updateUI({ browserKagiSessionLink: K })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    const inoState1 = readPersistedStateJson(dataFile())

    // Swapping the environment value and UI secret must produce a distinct persisted state.
    store.updateSettings({ agentDefaultEnv: { claude: { browserKagiSessionLink: K } } })
    store.updateUI({ browserKagiSessionLink: C })
    vi.advanceTimersByTime(2000)
    await store.waitForPendingWrite()
    expect(readPersistedStateJson(dataFile())).not.toBe(inoState1)

    const reloaded = await createStore()
    expect(reloaded.getSettings().agentDefaultEnv?.claude?.browserKagiSessionLink).toBe(K)
    expect(reloaded.getUI().browserKagiSessionLink).toBe(C)
  })
})
