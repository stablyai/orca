import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedState,
  readPersistedStateJson
} from './persistence-test-harness'
// Keep undecryptable proxy secrets sealed and unapplied; preserve plaintext upgrades and unrelated saves (STA-3442).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  const { setSecretStore } = await import('../../shared/secret-store')
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
  const { Store } = await import('./loading-store/store')
  const { initDataPath } = await import('./loading-store/user-data-path')
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

    const persisted = readPersistedState(dataFile())
    expect(persisted.settings.httpProxyUrl).not.toBe(PROXY_URL)
    expect(Buffer.from(persisted.settings.httpProxyUrl ?? '', 'base64').toString('utf-8')).toMatch(
      /^enc:/
    )
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    const { applyElectronProxySettings, resetProxyApplicationForTests } =
      await import('../network/proxy-settings')
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

    cipherState.decryptAlwaysThrows = true
    const reloaded = await createStore()

    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    // Unrelated saves must retain ciphertext that may decrypt after keychain recovery.
    reloaded.updateSettings({ httpProxyBypassRules: 'localhost' })
    vi.advanceTimersByTime(2000)
    await reloaded.waitForPendingWrite()
    const persisted = readPersistedState(dataFile())
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
    const persisted = readPersistedState(dataFile())
    expect(persisted.settings.httpProxyUrl).toBe('')
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)
  })
})
