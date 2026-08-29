import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secret-store'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { dataFile, testState, writeDataFile } from '../../persistence-test-harness'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { initDataPath } from './user-data-path'
import { Store } from './store'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

/**
 * How long the fake keyring blocks the calling thread. Models the real hazard: on a locked
 * Linux keyring, `safeStorage.isEncryptionAvailable()` accepts the call and does not return —
 * a fast failure would not reproduce it. Bounded so a regression fails the suite instead of
 * wedging the worker, since a synchronous spin cannot be interrupted by a test timeout.
 */
const KEYRING_BLOCK_MS = 2_000
/** Generous enough to absorb loaded-CI jitter, far below one blocking probe. */
const NON_BLOCKING_CEILING_MS = 1_000

const PROXY_URL = 'http://proxy.example:8080'
const KAGI_LINK = 'https://kagi.com/search?token=abcdef0123456789'
const OWNER_LEASE = '11111111-2222-4333-8444-555555555555'
const COOKIE = 'auth=opencode-session-value'

function seal(plaintext: string): string {
  return Buffer.from(`encrypted:${plaintext}`, 'utf-8').toString('base64')
}

let probes = 0
let encryptions = 0

function installBlockingKeyring(): void {
  setSecretStore({
    isEncryptionAvailable: () => {
      probes += 1
      // Why a real thread block and not a counter alone: this is what a locked keyring does to
      // the main process, and it is the only thing that makes a pre-window probe fatal.
      // Why only the first call: OSCrypt resolves the backend once, so the block lands on
      // whichever call happens first — which is the whole question this file is about.
      if (probes === 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KEYRING_BLOCK_MS)
      }
      return true
    },
    // Why a nonce: a real keyring seals with a fresh IV, so re-encrypting a value yields
    // different bytes. Without that, a save that decrypted and re-encrypted a secret would be
    // indistinguishable from one that preserved the stored ciphertext untouched.
    encryptString: (plainText) => Buffer.from(`encrypted:${plainText}#${++encryptions}`, 'utf-8'),
    decryptString: (cipher) => {
      const decoded = cipher.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length).replace(/#\d+$/, '')
    },
    describeProtectionGap: () => null
  })
}

function writeProfileWithEverySecretSlot(): void {
  writeDataFile({
    settings: { httpProxyUrl: seal(PROXY_URL), opencodeSessionCookie: seal(COOKIE) },
    ui: { browserKagiSessionLink: seal(KAGI_LINK) },
    sshPtyConsumerRecoveries: [
      {
        targetId: 'target-1',
        clientInstanceId: 'client-1',
        serverBuildId: 'build-1',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: seal(OWNER_LEASE)
      }
    ]
  })
}

function createStore(options: { deferKeyringProbe?: boolean } = {}): Store {
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return new Store({ dataFile: dataFile(), ...options })
}

describe('deferred protected-secret hydration', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-deferred-secret-'))
    probes = 0
    encryptions = 0
    installBlockingKeyring()
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('never touches the keyring while loading a profile that has populated secret slots', () => {
    // Why this is the regression (STA-5782): the Store constructor runs ~1000 lines before the
    // first window exists, so one blocking probe here is a window that never appears.
    writeProfileWithEverySecretSlot()

    const startedAt = performance.now()
    const store = createStore({ deferKeyringProbe: true })
    const elapsedMs = performance.now() - startedAt

    expect(probes).toBe(0)
    expect(elapsedMs).toBeLessThan(NON_BLOCKING_CEILING_MS)
    // Withheld, not read: a deferred load exposes nothing, exactly as an unavailable keyring does.
    expect(store.getSettings().httpProxyUrl).toBe('')
    expect(store.getSettings().opencodeSessionCookie).toBe('')
    store.freezeWrites()
  })

  it('restores every deferred slot once hydration runs', () => {
    writeProfileWithEverySecretSlot()
    const store = createStore({ deferKeyringProbe: true })

    const result = store.hydrateDeferredProtectedSecrets()

    expect(result.hydrated).toBe(true)
    expect(probes).toBeGreaterThan(0)
    expect(store.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(store.getSettings().opencodeSessionCookie).toBe(COOKIE)
    expect(store.getUI().browserKagiSessionLink).toBe(KAGI_LINK)
    expect(store.getSshPtyConsumerRecovery('target-1')?.ownerLease).toBe(OWNER_LEASE)
    store.freezeWrites()
  })

  it('tells settings and UI listeners the real values so startup work can re-run against them', () => {
    writeProfileWithEverySecretSlot()
    const store = createStore({ deferKeyringProbe: true })
    const seen: Partial<GlobalSettings>[] = []
    const seenUi: (string | null | undefined)[] = []
    store.onSettingsChanged((updates) => void seen.push(updates))
    store.onUIChanged((ui) => void seenUi.push(ui.browserKagiSessionLink))

    const result = store.hydrateDeferredProtectedSecrets()

    expect(result.settingsUpdates.httpProxyUrl).toBe(PROXY_URL)
    expect(seen.map((updates) => updates.httpProxyUrl)).toEqual([PROXY_URL])
    expect(result.uiChanged).toBe(true)
    expect(seenUi).toEqual([KAGI_LINK])
    store.freezeWrites()
  })

  it('keeps the stored ciphertext byte-for-byte when a save lands before hydration', () => {
    // Why: a withheld read is not an empty value. Writing the profile back with the slots blank
    // would destroy secrets the user still has, which no failed probe justifies.
    writeProfileWithEverySecretSlot()
    const before = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
      settings: { httpProxyUrl: string }
    }
    const store = createStore({ deferKeyringProbe: true })

    store.updateSettings({ terminalFontSize: 15 })
    store.flushOrThrow()

    const after = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
      settings: { httpProxyUrl: string; opencodeSessionCookie: string }
      ui: { browserKagiSessionLink: string }
      sshPtyConsumerRecoveries: { ownerLease: string }[]
    }
    expect(after.settings.httpProxyUrl).toBe(before.settings.httpProxyUrl)
    expect(after.settings.opencodeSessionCookie).toBe(seal(COOKIE))
    expect(after.ui.browserKagiSessionLink).toBe(seal(KAGI_LINK))
    expect(after.sshPtyConsumerRecoveries.at(0)?.ownerLease).toBe(seal(OWNER_LEASE))
    store.freezeWrites()
  })

  it('persists the clear when hydration finds an unusable secret, with no explicit flush', async () => {
    // Why without a flush: hydration runs long after startup, so nothing else is guaranteed to
    // save. Dropping the retained blob in memory only would resurrect the bad value next launch.
    writeDataFile({ settings: { httpProxyUrl: seal('!!! not a url !!!') } })
    const store = createStore({ deferKeyringProbe: true })
    // Why flush first: load-time migrations schedule their own save, and a hydration that
    // scheduled nothing would still reach disk on the back of it.
    store.flushOrThrow()
    expect(
      (JSON.parse(readFileSync(dataFile(), 'utf-8')) as { settings: { httpProxyUrl: string } })
        .settings.httpProxyUrl
    ).toBe(seal('!!! not a url !!!'))

    const result = store.hydrateDeferredProtectedSecrets()
    expect(result.needsSave).toBe(true)
    await vi.waitFor(
      async () => {
        await store.waitForPendingWrite()
        const saved = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
          settings: { httpProxyUrl: string }
        }
        expect(saved.settings.httpProxyUrl).toBe('')
      },
      { timeout: 10_000, interval: 100 }
    )
    store.freezeWrites()
  })

  it('persists the drop when hydration finds an unusable SSH owner lease', async () => {
    // Why: the lease decodes to a value normalization rejects, so hydration drops the record.
    // Dropping it in memory only would resurrect it next launch and re-present a lease the
    // relay will refuse, so the drop has to reach disk on hydration's own save.
    writeDataFile({
      sshPtyConsumerRecoveries: [
        {
          targetId: 'target-1',
          clientInstanceId: 'client-1',
          serverBuildId: 'build-1',
          clientGeneration: 1,
          ownerGeneration: 1,
          ownerLease: seal('')
        }
      ]
    })
    const store = createStore({ deferKeyringProbe: true })
    // Why flush first: load-time migrations schedule their own save, and a hydration that
    // scheduled nothing would still reach disk on the back of it.
    store.flushOrThrow()
    expect(
      (JSON.parse(readFileSync(dataFile(), 'utf-8')) as { sshPtyConsumerRecoveries: unknown[] })
        .sshPtyConsumerRecoveries
    ).toHaveLength(1)

    const result = store.hydrateDeferredProtectedSecrets()

    expect(result.needsSave).toBe(true)
    await vi.waitFor(
      async () => {
        await store.waitForPendingWrite()
        const saved = JSON.parse(readFileSync(dataFile(), 'utf-8')) as {
          sshPtyConsumerRecoveries: unknown[]
        }
        expect(saved.sshPtyConsumerRecoveries).toEqual([])
      },
      { timeout: 10_000, interval: 100 }
    )
    store.freezeWrites()
  })

  it('keeps a secret written while the window was up instead of reverting it on hydration', async () => {
    // Why this is reachable: the whole point of the deferral is that the window paints first, so
    // there is a real interval in which the app is on screen and every protected slot still reads
    // as empty. A write in that interval is the user's current intent; the retained ciphertext is
    // the value they replaced. Hydrating over it silently restores the old proxy — and a proxy is
    // where traffic goes, so a silent revert sends it somewhere the user has stopped choosing.
    writeProfileWithEverySecretSlot()
    const store = createStore({ deferKeyringProbe: true })
    const seen: Partial<GlobalSettings>[] = []
    store.onSettingsChanged((updates) => void seen.push(updates))

    store.updateSettings({
      httpProxyUrl: 'http://replacement.example:9090',
      opencodeSessionCookie: 'auth=replacement-session-value'
    })
    store.updateUI({ browserKagiSessionLink: 'https://kagi.com/search?token=99998888aaaabbbb' })
    const result = store.hydrateDeferredProtectedSecrets()

    expect(store.getSettings().httpProxyUrl).toBe('http://replacement.example:9090')
    expect(store.getSettings().opencodeSessionCookie).toBe('auth=replacement-session-value')
    expect(store.getUI().browserKagiSessionLink).toBe(
      'https://kagi.com/search?token=99998888aaaabbbb'
    )
    // Why the listener census too: a revert announced to listeners re-runs startup work — the
    // proxy re-apply in index.ts above all — against the value the user just discarded.
    expect(seen.map((updates) => updates.httpProxyUrl)).not.toContain(PROXY_URL)
    expect(seen.map((updates) => updates.opencodeSessionCookie)).not.toContain(COOKIE)
    expect(result.settingsUpdates.httpProxyUrl).toBeUndefined()
    expect(result.settingsUpdates.opencodeSessionCookie).toBeUndefined()
    // Why an untouched slot in the same run: the guard must be per slot, not a blanket bail that
    // would strand every secret the user did not happen to overwrite.
    expect(store.getSshPtyConsumerRecovery('target-1')?.ownerLease).toBe(OWNER_LEASE)
    await store.waitForPendingWrite()
    store.freezeWrites()
  })

  it('probes inline when the host opens no window, so nothing pairs against a stalled main thread', () => {
    // Why pinned: headless serve advertises readiness with no window to defer behind, and an
    // earlier deferral moved this block to after clients could already connect (STA-5765).
    writeProfileWithEverySecretSlot()

    const store = createStore()

    expect(probes).toBeGreaterThan(0)
    expect(store.getSettings().httpProxyUrl).toBe(PROXY_URL)
    expect(store.hydrateDeferredProtectedSecrets().hydrated).toBe(false)
    store.freezeWrites()
  })

  it('reports nothing to hydrate when the load already probed', () => {
    writeProfileWithEverySecretSlot()
    const store = createStore()

    const result = store.hydrateDeferredProtectedSecrets()

    expect(result).toEqual({
      hydrated: false,
      settingsUpdates: {},
      uiChanged: false,
      needsSave: false
    })
    store.freezeWrites()
  })
})
