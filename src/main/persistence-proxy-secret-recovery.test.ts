import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from './persistence-test-harness'
// STA-3442: httpProxyUrl is the only network setting stored via safeStorage.
// On macOS a keychain reset/denial makes decryptString throw at load, and the
// raw ciphertext then masqueraded as a configured proxy: applyElectronProxySettings
// silently fell back to DIRECT and the garbage re-persisted forever. These tests
// pin the recovery contract: undecryptable values stay sealed (never applied
// or destroyed), plaintext values survive as the upgrade path, and safeStorage
// failures cannot expose the proxy secret or kill unrelated saves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { SshTarget } from '../shared/ssh-types'

const testState = { dir: '' }

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

const cipherState = {
  encryptionAvailable: true,
  availabilityThrows: false,
  decryptAlwaysThrows: false
}

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  session: { defaultSession: undefined }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  vi.resetModules()
  const { setSecretStore } = await import('../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => {
      if (cipherState.availabilityThrows) {
        throw new Error('safeStorage cannot be used before the app is ready')
      }
      return cipherState.encryptionAvailable
    },
    encryptString: (plaintext) => Buffer.from(`enc:${randomUUID()}:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext) => {
      if (cipherState.decryptAlwaysThrows) {
        throw new Error('keychain access denied')
      }
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    },
    describeProtectionGap: () => null
  })
  const { Store, initDataPath } = await import('./persistence')
  // Why here: userData resolves through AppEnvironment, and this must point at this
  // file's temp dir rather than the global fake's shared one, after resetModules.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

const PROXY_URL = 'http://127.0.0.1:8080'
const BYPASS_RULES = '<local>'

describe('httpProxyUrl secret recovery (STA-3442)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    cipherState.encryptionAvailable = true
    cipherState.availabilityThrows = false
    cipherState.decryptAlwaysThrows = false
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function seedConfiguredProxy() {
    const store = await createStore()
    store.updateSettings({ httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    return store
  }

  it('persists the configured proxy across a restart and applies it as fixed_servers', async () => {
    await seedConfiguredProxy()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string; httpProxyBypassRules: string }
    }
    // On disk the URL is ciphertext (base64 of the mock's enc: payload), never plaintext.
    expect(persisted.settings.httpProxyUrl).not.toBe(PROXY_URL)
    expect(Buffer.from(persisted.settings.httpProxyUrl, 'base64').toString('utf-8')).toMatch(
      /^enc:/
    )
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    const { applyElectronProxySettings, resetProxyApplicationForTests } =
      await import('./network/proxy-settings')
    resetProxyApplicationForTests()
    const setProxy = vi.fn(async () => {})
    const result = await applyElectronProxySettings(reloaded.getSettings(), {
      proxySession: { resolveProxy: async () => 'DIRECT', setProxy },
      env: {}
    })
    expect(result).toEqual({
      source: 'settings',
      proxyRules: PROXY_URL,
      proxyBypassRules: BYPASS_RULES
    })
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: PROXY_URL,
      proxyBypassRules: BYPASS_RULES
    })
  })

  it('seals an undecryptable httpProxyUrl without destroying its ciphertext', async () => {
    await seedConfiguredProxy()
    const originalCiphertext = JSON.parse(readPersistedStateJson(dataFile())).settings.httpProxyUrl

    // Keychain reset/denial: every decrypt now fails.
    cipherState.decryptAlwaysThrows = true
    const reloaded = await createStore()

    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    // Bypass rules are not encrypted and must survive.
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    // Unrelated durable changes must not erase ciphertext that can recover later.
    reloaded.updateSettings({ httpProxyBypassRules: 'localhost' })
    vi.advanceTimersByTime(2000)
    await reloaded.waitForPendingWrite()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe(originalCiphertext)
  })

  it('keeps a plaintext httpProxyUrl on disk readable (pre-encryption/hand-edited upgrade path)', async () => {
    mkdirSync(dirname(dataFile()), { recursive: true })
    writeFileSync(
      dataFile(),
      JSON.stringify({ settings: { httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES } }),
      'utf-8'
    )

    const store = await createStore()
    expect(store.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(store.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)
  })

  it('saves non-secret proxy settings without plaintext when availability throws', async () => {
    cipherState.availabilityThrows = true

    const store = await createStore()
    store.updateSettings({ httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    expect(existsSync(join(testState.dir, 'profile-state.db'))).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      settings: { httpProxyUrl: string; httpProxyBypassRules: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe('')
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)
  })
})

describe('ssh target httpProxyUrl secret recovery', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    cipherState.encryptionAvailable = true
    cipherState.availabilityThrows = false
    cipherState.decryptAlwaysThrows = false
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function sshTargetFixture(): SshTarget {
    return {
      id: 'ssh-1',
      label: 'Lab',
      host: 'lab.example.com',
      port: 22,
      username: 'deploy',
      httpProxyUrl: 'http://user:secret@proxy.lan:3128'
    }
  }

  async function seedTargetProxy() {
    const store = await createStore()
    store.addSshTarget(sshTargetFixture())
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()
    return store
  }

  it('persists a per-host proxy URL as ciphertext and decrypts it on reload', async () => {
    await seedTargetProxy()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      sshTargets: { id: string; httpProxyUrl: string }[]
    }
    const stored = persisted.sshTargets.find((target) => target.id === 'ssh-1')
    expect(stored?.httpProxyUrl).toBeDefined()
    // On disk the URL is ciphertext (base64 of the mock's enc: payload), never plaintext.
    expect(stored?.httpProxyUrl).not.toContain('user:secret')
    expect(Buffer.from(stored?.httpProxyUrl ?? '', 'base64').toString('utf-8')).toMatch(/^enc:/)

    const reloaded = await createStore()
    expect(reloaded.getSshTarget('ssh-1')?.httpProxyUrl).toBe('http://user:secret@proxy.lan:3128')
  })

  it('seals an undecryptable per-host proxy URL without destroying its ciphertext', async () => {
    await seedTargetProxy()
    const originalCiphertext = (
      JSON.parse(readPersistedStateJson(dataFile())) as {
        sshTargets: { id: string; httpProxyUrl: string }[]
      }
    ).sshTargets.find((target) => target.id === 'ssh-1')?.httpProxyUrl

    cipherState.decryptAlwaysThrows = true
    const reloaded = await createStore()

    expect(reloaded.getSshTarget('ssh-1')?.httpProxyUrl).toBe('')
    // Unrelated fields survive.
    expect(reloaded.getSshTarget('ssh-1')?.host).toBe('lab.example.com')

    // An unrelated save must not overwrite the retained ciphertext with the sealed empty.
    reloaded.updateSshTarget('ssh-1', { label: 'Renamed' })
    vi.advanceTimersByTime(2000)
    await reloaded.waitForPendingWrite()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      sshTargets: { id: string; httpProxyUrl: string }[]
    }
    expect(persisted.sshTargets.find((target) => target.id === 'ssh-1')?.httpProxyUrl).toBe(
      originalCiphertext
    )
  })

  it('keeps a recoverable per-host proxy ciphertext across an unrelated save when the keychain is unavailable', async () => {
    await seedTargetProxy()

    // Why unavailable, not failing: this is the load-time sealed-empty state the
    // save path must carry through, not a decrypt error.
    cipherState.encryptionAvailable = false
    const sealed = await createStore()
    expect(sealed.getSshTarget('ssh-1')?.httpProxyUrl).toBe('')

    cipherState.encryptionAvailable = true
    sealed.updateSshTarget('ssh-1', { label: 'Renamed while sealed' })
    vi.advanceTimersByTime(2000)
    await sealed.waitForPendingWrite()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      sshTargets: { id: string; httpProxyUrl: string }[]
    }
    expect(
      Buffer.from(
        persisted.sshTargets.find((target) => target.id === 'ssh-1')?.httpProxyUrl ?? '',
        'base64'
      ).toString('utf-8')
    ).toMatch(/^enc:/)

    // Keychain restored: the original credentials come back.
    const recovered = await createStore()
    expect(recovered.getSshTarget('ssh-1')?.httpProxyUrl).toBe('http://user:secret@proxy.lan:3128')
  })

  it('persists an empty per-host proxy for targets that never had one', async () => {
    const store = await createStore()
    const target = sshTargetFixture()
    delete target.httpProxyUrl
    store.addSshTarget(target)
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    // Why '' not absent: the proxy always routes through the protected-secret machinery,
    // mirroring how the local settings.httpProxyUrl persists its empty state.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
    const persisted = JSON.parse(readPersistedStateJson(dataFile())) as {
      sshTargets: { id: string; httpProxyUrl?: string }[]
    }
    expect(persisted.sshTargets.find((entry) => entry.id === 'ssh-1')?.httpProxyUrl).toBe('')
  })
})
