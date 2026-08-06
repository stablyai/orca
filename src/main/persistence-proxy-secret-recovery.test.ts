// STA-3442: httpProxyUrl is the only network setting stored via safeStorage.
// On macOS a keychain reset/denial makes decryptString throw at load, and the
// raw ciphertext then masqueraded as a configured proxy: applyElectronProxySettings
// silently fell back to DIRECT and the garbage re-persisted forever. These tests
// pin the recovery contract: undecryptable values are cleared (never applied,
// never re-saved as garbage), plaintext values survive as the upgrade path, and
// a throwing safeStorage.isEncryptionAvailable() cannot kill the whole save.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

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
  session: { defaultSession: undefined },
  safeStorage: {
    isEncryptionAvailable: () => {
      if (cipherState.availabilityThrows) {
        throw new Error('safeStorage cannot be used before the app is ready')
      }
      return cipherState.encryptionAvailable
    },
    encryptString: (plaintext: string) => Buffer.from(`enc:${randomUUID()}:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      if (cipherState.decryptAlwaysThrows) {
        throw new Error('keychain access denied')
      }
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('enc:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('enc:'.length + 36 + 1)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
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

  afterEach(() => {
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

    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
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

  it('clears an undecryptable httpProxyUrl instead of surfacing ciphertext as settings', async () => {
    await seedConfiguredProxy()

    // Keychain reset/denial: every decrypt now fails.
    cipherState.decryptAlwaysThrows = true
    const reloaded = await createStore()

    expect(reloaded.getSettings().httpProxyUrl).toBe('')
    // Bypass rules are not encrypted and must survive.
    expect(reloaded.getSettings().httpProxyBypassRules).toBe(BYPASS_RULES)

    // The cleanup must reach disk so garbage never round-trips back in.
    vi.advanceTimersByTime(2000)
    await reloaded.waitForPendingWrite()
    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
      settings: { httpProxyUrl: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe('')
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

  it('still saves and reloads the proxy when safeStorage.isEncryptionAvailable throws', async () => {
    cipherState.availabilityThrows = true

    const store = await createStore()
    store.updateSettings({ httpProxyUrl: PROXY_URL, httpProxyBypassRules: BYPASS_RULES })
    vi.advanceTimersByTime(1000)
    await store.waitForPendingWrite()

    // Encryption degraded to plaintext passthrough; the save must not be lost.
    expect(existsSync(dataFile())).toBe(true)
    const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
      settings: { httpProxyUrl: string; httpProxyBypassRules: string }
    }
    expect(persisted.settings.httpProxyUrl).toBe(PROXY_URL)
    expect(persisted.settings.httpProxyBypassRules).toBe(BYPASS_RULES)

    const reloaded = await createStore()
    expect(reloaded.getSettings().httpProxyUrl).toBe(PROXY_URL)
  })
})
