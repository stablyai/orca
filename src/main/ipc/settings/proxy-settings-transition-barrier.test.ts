import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, Session } from 'electron'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Store } from '../../persistence/loading-store/store'

type BeforeRequestListener = (
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
) => void

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type FakeProxySession = Session & {
  appliedConfigs: { mode?: string; proxyRules?: string; proxyBypassRules?: string }[]
  pendingSetProxy: Deferred[]
  hasBeforeRequestListener: () => boolean
  probeRequest: () => { settled: boolean; response: Electron.CallbackResponse | null }
}

function createFakeProxySession(): FakeProxySession {
  let beforeRequestListener: BeforeRequestListener | null = null
  const appliedConfigs: { mode?: string; proxyRules?: string; proxyBypassRules?: string }[] = []
  const pendingSetProxy: Deferred[] = []

  const fakeSession = {
    appliedConfigs,
    pendingSetProxy,
    hasBeforeRequestListener: () => beforeRequestListener !== null,
    probeRequest: () => {
      const result: { settled: boolean; response: Electron.CallbackResponse | null } = {
        settled: false,
        response: null
      }
      if (!beforeRequestListener) {
        result.settled = true
        result.response = {}
        return result
      }
      const details: Electron.OnBeforeRequestListenerDetails = {
        id: 1,
        url: 'https://example.com/',
        method: 'GET',
        referrer: '',
        timestamp: 0,
        resourceType: 'mainFrame',
        uploadData: []
      }
      beforeRequestListener(details, (response) => {
        result.settled = true
        result.response = response
      })
      return result
    },
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn((config: { mode?: string; proxyRules?: string; proxyBypassRules?: string }) => {
      appliedConfigs.push(config)
      const deferred = createDeferred()
      pendingSetProxy.push(deferred)
      return deferred.promise
    }),
    closeAllConnections: vi.fn(async () => {}),
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          filterOrListener: Electron.WebRequestFilter | BeforeRequestListener | null,
          maybeListener?: BeforeRequestListener | null
        ) => {
          beforeRequestListener =
            typeof filterOrListener === 'function' || filterOrListener === null
              ? filterOrListener
              : (maybeListener ?? null)
        }
      )
    },
    extensions: {
      getAllExtensions: () => [],
      on: vi.fn(),
      off: vi.fn()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal Electron Session test double implementing only the proxy and webRequest surface used by the barrier
  return fakeSession as unknown as FakeProxySession
}

type FakeStoreHarness = {
  store: Store
  onUpdateSettings: ((updates: Partial<GlobalSettings>) => void) | null
  notifiedUpdates: Partial<GlobalSettings>[]
}

function createFakeStore(initial: Partial<GlobalSettings> = {}): FakeStoreHarness {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: isolated settings fixture populates only the fields read by settings:set and proxy side effects
  let current = {
    httpProxyUrl: '',
    httpProxyBypassRules: '',
    ...initial
  } as GlobalSettings
  const listeners = new Set<
    (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  >()
  const storeDouble = {
    getSettings: () => current,
    onSettingsChanged: (
      listener: (
        updates: Partial<GlobalSettings>,
        settings: GlobalSettings,
        originWebContentsId?: number
      ) => void
    ) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    updateSettings: (
      updates: Partial<GlobalSettings>,
      options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
    ) => {
      current = { ...current, ...updates }
      harness.onUpdateSettings?.(updates)
      if (options.notifyListeners) {
        harness.notifiedUpdates.push(updates)
        for (const listener of listeners) {
          listener(updates, current, options.originWebContentsId)
        }
      }
      return current
    }
  }
  const harness: FakeStoreHarness = {
    onUpdateSettings: null,
    notifiedUpdates: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal Store test double implementing only the settings methods invoked by settings IPC
    store: storeDouble as unknown as Store
  }
  return harness
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
  }
}

describe('settings:set proxy transition barrier', () => {
  const ipcHandlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  let defaultSession: FakeProxySession
  let browserSession: FakeProxySession
  let updaterSession: FakeProxySession
  let partitions: Map<string, FakeProxySession>

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal IpcMainInvokeEvent test double providing event.sender.id
  const fakeEvent = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent

  beforeEach(() => {
    vi.resetModules()
    ipcHandlers.clear()
    defaultSession = createFakeProxySession()
    browserSession = createFakeProxySession()
    updaterSession = createFakeProxySession()
    partitions = new Map([
      ['persist:browser-profile-1', browserSession],
      ['electron-updater', updaterSession]
    ])

    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] },
      nativeTheme: { themeSource: 'system' },
      ipcMain: {
        handle: (
          channel: string,
          handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
        ) => {
          ipcHandlers.set(channel, handler)
        },
        on: vi.fn()
      },
      session: {
        defaultSession,
        fromPartition: (partition: string) => {
          const existing = partitions.get(partition)
          if (existing) {
            return existing
          }
          const created = createFakeProxySession()
          partitions.set(partition, created)
          return created
        }
      }
    }))

    vi.doMock('./lazy-settings-import-and-app-icon-ipc', () => ({
      registerLazySettingsImportAndAppIconHandlers: vi.fn()
    }))
    vi.doMock('../../updater/updater-service-slot', () => ({
      applyAutomaticUpdatesSetting: vi.fn()
    }))
    vi.doMock('../../claude/agent-view/agent-view-service', () => ({
      getClaudeAgentViewService: () => ({ reconcile: vi.fn(async () => {}) })
    }))
    vi.doMock('../../browser/sessions/profiles/browser-session-registry', () => ({
      browserSessionRegistry: {
        listProfiles: () => [{ id: 'profile-1', partition: 'persist:browser-profile-1' }]
      }
    }))
    vi.doMock('../../telemetry/client', () => ({ track: vi.fn() }))
    vi.doMock('../../i18n/main-i18n', () => ({ setMainUiLanguage: vi.fn(async () => {}) }))
    vi.doMock('../../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
    vi.doMock('../../tray/system-tray', () => ({ rebuildSystemTrayMenu: vi.fn() }))
    vi.doMock('../../workspaces/creation/worktree-root-preparation', () => ({
      prepareLocalWorktreeRootsForRepos: vi.fn(async () => {})
    }))
    vi.doMock('../worktrees/creation/worktree-base-directory-watcher', () => ({
      scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
    }))
  })

  afterEach(() => {
    vi.doUnmock('./settings-set-handler')
    vi.restoreAllMocks()
  })

  async function setupRuntime(storeHarness: FakeStoreHarness) {
    const { setDefaultProxySessionResolver } =
      await import('../../network/electron-default-proxy-session')
    const { isProxySessionApplicationReady } = await import('../../network/proxy-settings')
    const { installElectronProxyRequestGuard } =
      await import('../../network/electron-proxy-request-guard')
    const { installBrowserSessionRequestGate } =
      await import('../../browser/sessions/requests/browser-session-request-gate')
    const { registerSettingsHandlers } = await import('./settings')

    setDefaultProxySessionResolver(() => defaultSession)
    installElectronProxyRequestGuard(defaultSession)
    installBrowserSessionRequestGate(browserSession)
    registerSettingsHandlers(storeHarness.store)

    const setSettings = ipcHandlers.get('settings:set')
    expect(setSettings).toBeTypeOf('function')

    return {
      isProxySessionApplicationReady,
      invokeSettingsSet: (args: Partial<GlobalSettings>) =>
        Promise.resolve(setSettings!(fakeEvent, args))
    }
  }

  it('activates all session request barriers before yielding on both cold and cached imports', async () => {
    const storeHarness = createFakeStore()
    const { isProxySessionApplicationReady, invokeSettingsSet } = await setupRuntime(storeHarness)

    for (const proxyUrl of ['http://proxy-cold.example:8080', 'http://proxy-cached.example:8080']) {
      const snapshotReady = createDeferred<{
        defaultReady: boolean
        browserReady: boolean
        updaterReady: boolean
        browserGateListening: boolean
        defaultProbe: { settled: boolean; response: Electron.CallbackResponse | null }
        browserProbe: { settled: boolean; response: Electron.CallbackResponse | null }
        updaterProbe: { settled: boolean; response: Electron.CallbackResponse | null }
      }>()

      storeHarness.onUpdateSettings = () => {
        queueMicrotask(() => {
          snapshotReady.resolve({
            defaultReady: isProxySessionApplicationReady(defaultSession),
            browserReady: isProxySessionApplicationReady(browserSession),
            updaterReady: isProxySessionApplicationReady(updaterSession),
            browserGateListening: browserSession.hasBeforeRequestListener(),
            defaultProbe: defaultSession.probeRequest(),
            browserProbe: browserSession.probeRequest(),
            updaterProbe: updaterSession.probeRequest()
          })
        })
      }

      const setPromise = invokeSettingsSet({ httpProxyUrl: proxyUrl })
      const snapshot = await snapshotReady.promise

      expect(snapshot.defaultReady).toBe(false)
      expect(snapshot.browserReady).toBe(false)
      expect(snapshot.updaterReady).toBe(false)
      expect(snapshot.browserGateListening).toBe(true)
      expect(snapshot.defaultProbe.settled).toBe(false)
      expect(snapshot.browserProbe.settled).toBe(false)
      expect(snapshot.updaterProbe.settled).toBe(false)

      await vi.waitFor(() => {
        expect(defaultSession.pendingSetProxy).toHaveLength(1)
        expect(browserSession.pendingSetProxy).toHaveLength(1)
        expect(updaterSession.pendingSetProxy).toHaveLength(1)
      })
      defaultSession.pendingSetProxy.shift()!.resolve()
      browserSession.pendingSetProxy.shift()!.resolve()
      updaterSession.pendingSetProxy.shift()!.resolve()
      await setPromise
      await flushMicrotasks()

      expect(snapshot.defaultProbe.settled).toBe(true)
      expect(snapshot.defaultProbe.response).toEqual({})
      expect(snapshot.browserProbe.settled).toBe(true)
      expect(snapshot.browserProbe.response).toEqual({})
      expect(snapshot.updaterProbe.settled).toBe(true)
      expect(snapshot.updaterProbe.response).toEqual({})
      expect(browserSession.hasBeforeRequestListener()).toBe(false)
      expect(defaultSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
      expect(browserSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
      expect(updaterSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
    }
  })

  it('does not commit settings when the lazy handler import rejects, so a same-value retry applies', async () => {
    const storeHarness = createFakeStore()
    vi.doMock('./settings-set-handler', () => {
      throw new Error('simulated chunk load failure')
    })

    const { invokeSettingsSet } = await setupRuntime(storeHarness)
    const proxyUrl = 'http://proxy-retry.example:8080'

    await expect(invokeSettingsSet({ httpProxyUrl: proxyUrl })).rejects.toThrow()
    expect(storeHarness.store.getSettings().httpProxyUrl).toBe('')
    expect(storeHarness.notifiedUpdates).toHaveLength(0)

    vi.doUnmock('./settings-set-handler')

    const retryPromise = invokeSettingsSet({ httpProxyUrl: proxyUrl })
    await vi.waitFor(() => {
      expect(defaultSession.pendingSetProxy).toHaveLength(1)
      expect(browserSession.pendingSetProxy).toHaveLength(1)
      expect(updaterSession.pendingSetProxy).toHaveLength(1)
    })

    const defaultProbe = defaultSession.probeRequest()
    const browserProbe = browserSession.probeRequest()
    const updaterProbe = updaterSession.probeRequest()
    expect(defaultProbe.settled).toBe(false)
    expect(browserProbe.settled).toBe(false)
    expect(updaterProbe.settled).toBe(false)

    defaultSession.pendingSetProxy.shift()!.resolve()
    browserSession.pendingSetProxy.shift()!.resolve()
    updaterSession.pendingSetProxy.shift()!.resolve()
    await retryPromise
    await flushMicrotasks()

    expect(storeHarness.store.getSettings().httpProxyUrl).toBe(proxyUrl)
    expect(defaultProbe.settled).toBe(true)
    expect(browserProbe.settled).toBe(true)
    expect(updaterProbe.settled).toBe(true)
    expect(defaultSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
    expect(browserSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
    expect(updaterSession.appliedConfigs.at(-1)?.proxyRules).toBe(proxyUrl)
  })

  it('keeps concurrent requests held across overlapping proxy transitions until the newest policy settles', async () => {
    const storeHarness = createFakeStore()
    const { invokeSettingsSet } = await setupRuntime(storeHarness)

    const first = invokeSettingsSet({ httpProxyUrl: 'http://proxy-1.example:8080' })
    const second = invokeSettingsSet({ httpProxyUrl: 'http://proxy-2.example:8080' })
    await vi.waitFor(() => {
      expect(defaultSession.pendingSetProxy).toHaveLength(1)
      expect(browserSession.pendingSetProxy).toHaveLength(1)
      expect(updaterSession.pendingSetProxy).toHaveLength(1)
    })

    const defaultProbe = defaultSession.probeRequest()
    const browserProbe = browserSession.probeRequest()
    const updaterProbe = updaterSession.probeRequest()
    expect(defaultProbe.settled).toBe(false)
    expect(browserProbe.settled).toBe(false)
    expect(updaterProbe.settled).toBe(false)

    // Complete proxy-1 while proxy-2 is still pending on each session's queue.
    defaultSession.pendingSetProxy.shift()!.resolve()
    browserSession.pendingSetProxy.shift()!.resolve()
    updaterSession.pendingSetProxy.shift()!.resolve()
    await first
    await vi.waitFor(() => {
      expect(defaultSession.pendingSetProxy).toHaveLength(1)
      expect(browserSession.pendingSetProxy).toHaveLength(1)
      expect(updaterSession.pendingSetProxy).toHaveLength(1)
    })

    expect(defaultProbe.settled).toBe(false)
    expect(browserProbe.settled).toBe(false)
    expect(updaterProbe.settled).toBe(false)

    // Complete proxy-2; all held requests are now admitted under the newest policy.
    defaultSession.pendingSetProxy.shift()!.resolve()
    browserSession.pendingSetProxy.shift()!.resolve()
    updaterSession.pendingSetProxy.shift()!.resolve()
    await second
    await flushMicrotasks()

    expect(defaultProbe.settled).toBe(true)
    expect(defaultProbe.response).toEqual({})
    expect(browserProbe.settled).toBe(true)
    expect(browserProbe.response).toEqual({})
    expect(updaterProbe.settled).toBe(true)
    expect(updaterProbe.response).toEqual({})
    expect(defaultSession.appliedConfigs.map((c) => c.proxyRules)).toEqual([
      'http://proxy-1.example:8080',
      'http://proxy-2.example:8080'
    ])
    expect(browserSession.appliedConfigs.map((c) => c.proxyRules)).toEqual([
      'http://proxy-1.example:8080',
      'http://proxy-2.example:8080'
    ])
    expect(updaterSession.appliedConfigs.map((c) => c.proxyRules)).toEqual([
      'http://proxy-1.example:8080',
      'http://proxy-2.example:8080'
    ])
  })
})
