/* eslint-disable max-lines -- Why: attachMainWindowServices centralizes main-window IPC wiring; keeping its integration-style mocks together avoids brittle cross-file setup. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const {
  onMock,
  removeAllListenersMock,
  removeListenerMock,
  setPermissionRequestHandlerMock,
  setPermissionCheckHandlerMock,
  handleMock,
  removeHandlerMock,
  systemPreferencesAskForMediaAccessMock,
  systemPreferencesGetMediaAccessStatusMock,
  registerRepoHandlersMock,
  registerWorktreeHandlersMock,
  registerPtyHandlersMock,
  hydrateLocalPtyRegistryAtBootMock,
  setupAutoUpdaterMock,
  sessionFromPartitionMock,
  setDevicePermissionHandlerMock,
  setDisplayMediaRequestHandlerMock,
  browserManagerUnregisterAllMock,
  browserManagerUnregisterGuestsForRendererMock,
  browserManagerNotifyPermissionDeniedMock,
  browserManagerHandleGuestWillDownloadMock,
  getMainWindowForWebContentsMock,
  getFocusedOrLastActiveMainWindowMock,
  getMainWindowByIdMock,
  sendToWindowMock,
  broadcastToMainWindowsMock,
  runWorktreeChangeInvalidatorsMock
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  removeListenerMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
  setPermissionCheckHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  systemPreferencesAskForMediaAccessMock: vi.fn(),
  systemPreferencesGetMediaAccessStatusMock: vi.fn(),
  registerRepoHandlersMock: vi.fn(),
  registerWorktreeHandlersMock: vi.fn(),
  registerPtyHandlersMock: vi.fn(),
  hydrateLocalPtyRegistryAtBootMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setDevicePermissionHandlerMock: vi.fn(),
  setDisplayMediaRequestHandlerMock: vi.fn(),
  browserManagerUnregisterAllMock: vi.fn(),
  browserManagerUnregisterGuestsForRendererMock: vi.fn(),
  browserManagerNotifyPermissionDeniedMock: vi.fn(),
  browserManagerHandleGuestWillDownloadMock: vi.fn(),
  getMainWindowForWebContentsMock: vi.fn(),
  getFocusedOrLastActiveMainWindowMock: vi.fn(),
  getMainWindowByIdMock: vi.fn(),
  sendToWindowMock: vi.fn(),
  broadcastToMainWindowsMock: vi.fn(),
  runWorktreeChangeInvalidatorsMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  session: {
    fromPartition: sessionFromPartitionMock
  },
  systemPreferences: {
    askForMediaAccess: systemPreferencesAskForMediaAccessMock,
    getMediaAccessStatus: systemPreferencesGetMediaAccessStatusMock
  },
  ipcMain: {
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeListener: removeListenerMock,
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn()
  }
}))

vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: registerRepoHandlersMock
}))

vi.mock('../ipc/worktrees', () => ({
  registerWorktreeHandlers: registerWorktreeHandlersMock
}))

vi.mock('../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: runWorktreeChangeInvalidatorsMock
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(),
  registerPtyHandlers: registerPtyHandlersMock
}))

vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: hydrateLocalPtyRegistryAtBootMock
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    notifyPermissionDenied: browserManagerNotifyPermissionDeniedMock,
    handleGuestWillDownload: browserManagerHandleGuestWillDownloadMock,
    unregisterAll: browserManagerUnregisterAllMock,
    unregisterGuestsForRenderer: browserManagerUnregisterGuestsForRendererMock
  }
}))

vi.mock('./main-window-registry', () => ({
  getMainWindowForWebContents: getMainWindowForWebContentsMock,
  getFocusedOrLastActiveMainWindow: getFocusedOrLastActiveMainWindowMock,
  getMainWindowById: getMainWindowByIdMock,
  sendToWindow: sendToWindowMock,
  broadcastToMainWindows: broadcastToMainWindowsMock
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: setupAutoUpdaterMock
}))

import { attachMainWindowServices } from './attach-main-window-services'

type MockFn = ReturnType<typeof vi.fn>

type MainWindowStub = {
  id?: number
  isDestroyed?: MockFn
  on: MockFn
  webContents: {
    id?: number
    isDestroyed?: MockFn
    on: MockFn
    send?: MockFn
    reload?: MockFn
    session: {
      setPermissionRequestHandler: MockFn
      setPermissionCheckHandler: MockFn
    }
  }
}

type RuntimeStub = {
  attachWindow: MockFn
  setNotifier: MockFn
  markRendererReloading: MockFn
  markGraphUnavailable: MockFn
  resolveOwnerWindowIdForTabId: MockFn
  resolveOwnerWindowIdForWorktreeTab: MockFn
  resolveOwnerWindowIdForLeaf: MockFn
  resolveOwnerWindowIdForPtyId: MockFn
  resolveOwnerWindowIdForBrowserPageId: MockFn
  registerPtyOwnerWindow: MockFn
}

function createMainWindow(extraWebContents: { on?: MockFn; send?: MockFn } = {}): MainWindowStub {
  const window = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    webContents: {
      id: 1,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: setPermissionRequestHandlerMock,
        setPermissionCheckHandler: setPermissionCheckHandlerMock
      },
      ...extraWebContents
    }
  }
  ;(window.webContents as { __window?: MainWindowStub }).__window = window
  return window
}

function createStore(): Store & { flush: MockFn } {
  return { flush: vi.fn() } as Store & { flush: MockFn }
}

function createRuntime(): RuntimeStub {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    markRendererReloading: vi.fn(),
    markGraphUnavailable: vi.fn(),
    resolveOwnerWindowIdForTabId: vi.fn(() => null),
    resolveOwnerWindowIdForWorktreeTab: vi.fn(() => null),
    resolveOwnerWindowIdForLeaf: vi.fn(() => null),
    resolveOwnerWindowIdForPtyId: vi.fn(() => null),
    resolveOwnerWindowIdForBrowserPageId: vi.fn(() => null),
    registerPtyOwnerWindow: vi.fn()
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function getClosedHandlers(mainWindowOnMock: MockFn): (() => void)[] {
  return mainWindowOnMock.mock.calls
    .filter(([event]) => event === 'closed')
    .map(([, handler]) => handler as () => void)
}

describe('attachMainWindowServices', () => {
  beforeEach(() => {
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    removeListenerMock.mockReset()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    setPermissionRequestHandlerMock.mockReset()
    setPermissionCheckHandlerMock.mockReset()
    systemPreferencesAskForMediaAccessMock.mockReset()
    systemPreferencesGetMediaAccessStatusMock.mockReset()
    registerRepoHandlersMock.mockReset()
    registerWorktreeHandlersMock.mockReset()
    registerPtyHandlersMock.mockReset()
    hydrateLocalPtyRegistryAtBootMock.mockReset()
    setupAutoUpdaterMock.mockReset()
    sessionFromPartitionMock.mockReset()
    setDevicePermissionHandlerMock.mockReset()
    setDisplayMediaRequestHandlerMock.mockReset()
    browserManagerUnregisterAllMock.mockReset()
    browserManagerUnregisterGuestsForRendererMock.mockReset()
    browserManagerNotifyPermissionDeniedMock.mockReset()
    browserManagerHandleGuestWillDownloadMock.mockReset()
    getMainWindowForWebContentsMock.mockReset()
    getFocusedOrLastActiveMainWindowMock.mockReset()
    getMainWindowByIdMock.mockReset()
    sendToWindowMock.mockReset()
    broadcastToMainWindowsMock.mockReset()
    getMainWindowForWebContentsMock.mockImplementation((sender) => sender?.__window ?? null)
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDevicePermissionHandler: setDevicePermissionHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: vi.fn(),
      removeListener: vi.fn()
    })
    systemPreferencesAskForMediaAccessMock.mockResolvedValue(true)
    systemPreferencesGetMediaAccessStatusMock.mockReturnValue('granted')
  })

  it('reloads the app renderer through main and marks expected renderer teardown', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    expect(reloadHandler).toBeTypeOf('function')

    await reloadHandler?.({ sender: mainWindow.webContents })

    expect(onBeforeRendererReload).toHaveBeenCalledWith({
      webContentsId: 1,
      ignoreCache: false
    })
    expect(mainWindow.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('retries local PTY registry hydration after local startup services are ready', async () => {
    const localStartup = deferred()
    const store = createStore()

    attachMainWindowServices(
      createMainWindow() as never,
      store,
      createRuntime() as never,
      undefined,
      undefined,
      { awaitLocalPtyStartup: () => localStartup.promise }
    )

    expect(hydrateLocalPtyRegistryAtBootMock).toHaveBeenCalledTimes(1)
    expect(hydrateLocalPtyRegistryAtBootMock).toHaveBeenCalledWith(store)

    localStartup.resolve()
    await localStartup.promise
    await Promise.resolve()

    expect(hydrateLocalPtyRegistryAtBootMock).toHaveBeenCalledTimes(2)
    expect(hydrateLocalPtyRegistryAtBootMock).toHaveBeenLastCalledWith(store)
  })

  it('passes injected update quit cleanup to the auto-updater', async () => {
    const onBeforeUpdateQuit = vi.fn()
    const store = createStore()

    attachMainWindowServices(
      createMainWindow() as never,
      store,
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeUpdateQuit }
    )

    expect(setupAutoUpdaterMock).toHaveBeenCalledTimes(1)
    await setupAutoUpdaterMock.mock.calls[0][1].onBeforeQuit()

    expect(onBeforeUpdateQuit).toHaveBeenCalledTimes(1)
    expect(store.flush).toHaveBeenCalledTimes(1)
  })

  it('flushes the store before update quit when no cleanup is injected', async () => {
    const store = createStore()

    attachMainWindowServices(createMainWindow() as never, store, createRuntime() as never)

    await setupAutoUpdaterMock.mock.calls[0][1].onBeforeQuit()

    expect(store.flush).toHaveBeenCalledTimes(1)
  })

  it('ignores app reload requests from non-main webContents', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    await reloadHandler?.({ sender: { id: 999 } })

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).not.toHaveBeenCalled()
  })

  it('ignores app reload requests after the main window is destroyed without rereading webContents', () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()
    const mainWebContents = mainWindow.webContents

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    mainWindow.isDestroyed?.mockReturnValue(true)
    Object.defineProperty(mainWindow, 'webContents', {
      get: () => {
        throw new Error('webContents should not be read after registration')
      }
    })

    expect(() => reloadHandler?.({ sender: mainWebContents })).not.toThrow()

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWebContents.reload).not.toHaveBeenCalled()
  })

  it('ignores app reload requests after the main webContents is destroyed', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    mainWindow.webContents.isDestroyed?.mockReturnValue(true)
    await reloadHandler?.({ sender: mainWindow.webContents })

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).not.toHaveBeenCalled()
  })

  it('keeps the sender-safe app reload IPC handler when a window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    removeHandlerMock.mockClear()
    const closedHandlers = getClosedHandlers(mainWindowOnMock)
    expect(closedHandlers.length).toBeGreaterThan(0)
    for (const handler of closedHandlers) {
      handler()
    }

    expect(removeHandlerMock).not.toHaveBeenCalledWith('app:reload')
  })

  it('does not read destroyed webContents when unregistering browser guests on close', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    Object.defineProperty(mainWindow, 'webContents', {
      configurable: true,
      get() {
        throw new Error('Object has been destroyed')
      }
    })

    for (const handler of getClosedHandlers(mainWindowOnMock)) {
      expect(() => handler()).not.toThrow()
    }

    expect(browserManagerUnregisterGuestsForRendererMock).toHaveBeenCalledWith(1)
  })

  it('keeps the sender-safe app reload IPC handler when an older window closes late', () => {
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), createRuntime() as never)
    const oldClosedHandlers = getClosedHandlers(oldWindowOnMock)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
    newWindow.on = newWindowOnMock
    attachMainWindowServices(newWindow as never, createStore(), createRuntime() as never)

    removeHandlerMock.mockClear()
    for (const handler of oldClosedHandlers) {
      handler()
    }

    expect(removeHandlerMock).not.toHaveBeenCalledWith('app:reload')

    for (const handler of getClosedHandlers(newWindowOnMock)) {
      handler()
    }
    expect(removeHandlerMock).not.toHaveBeenCalledWith('app:reload')
  })

  it('only allows the explicit permission allowlist', async () => {
    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(2)
    const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0]
    const callback = vi.fn()

    permissionHandler(null, 'media', callback, { mediaTypes: ['audio'] })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
    permissionHandler(null, 'fullscreen', callback)
    permissionHandler(null, 'pointerLock', callback)
    permissionHandler(null, 'clipboard-read', callback)

    expect(callback.mock.calls).toEqual([[true], [true], [true], [false]])
  })

  it('requests macOS media access only when the renderer asks for media', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

      expect(systemPreferencesAskForMediaAccessMock).not.toHaveBeenCalled()

      const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0]
      const callback = vi.fn()
      permissionHandler(null, 'media', callback, {
        mediaTypes: ['audio', 'video']
      })

      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
      expect(systemPreferencesAskForMediaAccessMock.mock.calls).toEqual([
        ['microphone'],
        ['camera']
      ])
    } finally {
      Object.defineProperty(process, 'platform', platform ?? { value: process.platform })
    }
  })

  it('denies browser-session permissions, display capture, and downloads by default', async () => {
    const browserSessionOnMock = vi.fn()
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDevicePermissionHandler: setDevicePermissionHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: browserSessionOnMock,
      removeListener: vi.fn()
    })

    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const browserPermissionHandler = setPermissionRequestHandlerMock.mock.calls[1][0] as (
      wc: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
      details?: unknown
    ) => void
    const cb = vi.fn()
    const guestWc = {
      id: 401,
      getURL: vi.fn(() => 'https://example.com/account')
    }
    browserPermissionHandler(guestWc, 'fullscreen', cb)
    browserPermissionHandler(guestWc, 'notifications', cb)
    // Why: `media` routes through macOS TCC instead of being denied outright,
    // so pages inside the in-app browser can use camera/mic once Orca has been
    // granted Camera/Microphone at the OS level.
    browserPermissionHandler(guestWc, 'media', cb, { mediaTypes: ['video'] })
    await vi.waitFor(() => expect(cb.mock.calls).toEqual([[true], [false], [true]]))
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledTimes(1)
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 401,
      permission: 'notifications',
      rawUrl: 'https://example.com/account'
    })

    const browserCheckHandler = setPermissionCheckHandlerMock.mock.calls[1][0] as (
      wc: unknown,
      permission: string,
      origin: string,
      details?: { mediaType?: 'video' | 'audio' | 'unknown' }
    ) => boolean
    expect(browserCheckHandler(null, 'fullscreen', '')).toBe(true)
    expect(browserCheckHandler(null, 'notifications', '')).toBe(false)
    expect(browserCheckHandler(null, 'media', '', { mediaType: 'video' })).toBe(true)

    const displayMediaHandler = setDisplayMediaRequestHandlerMock.mock.calls[0][0]
    const displayCb = vi.fn()
    displayMediaHandler(null, displayCb)
    expect(displayCb).toHaveBeenCalledWith({
      video: undefined,
      audio: undefined
    })

    const willDownloadHandler = browserSessionOnMock.mock.calls.find(
      ([eventName]) => eventName === 'will-download'
    )?.[1] as (
      event: unknown,
      item: { getFilename: () => string },
      webContents: { id: number }
    ) => void
    const item = { getFilename: vi.fn(() => 'report.pdf') }
    willDownloadHandler({}, item, { id: 402 })
    expect(browserManagerHandleGuestWillDownloadMock).toHaveBeenCalledTimes(1)
    expect(browserManagerHandleGuestWillDownloadMock).toHaveBeenCalledWith({
      guestWebContentsId: 402,
      item
    })
  })

  it('wires browser-session WebAuthn device selection for security keys', () => {
    const browserSessionOnMock = vi.fn()
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDevicePermissionHandler: setDevicePermissionHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: browserSessionOnMock,
      removeListener: vi.fn()
    })

    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    expect(setDevicePermissionHandlerMock).toHaveBeenCalledWith(expect.any(Function))
    const devicePermissionHandler = setDevicePermissionHandlerMock.mock.calls[0][0] as (details: {
      deviceType: string
      origin: string
      device: { collections?: { usagePage?: number }[] }
    }) => boolean
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'https://github.com',
        device: { collections: [{ usagePage: 0xf1d0 }] }
      })
    ).toBe(true)
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'http://[::1]:5173',
        device: { collections: [{ usagePage: 0xf1d0 }] }
      })
    ).toBe(true)
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'https://github.com',
        device: { collections: [{ usagePage: 1 }] }
      })
    ).toBe(false)

    const browserCheckHandler = setPermissionCheckHandlerMock.mock.calls[1][0] as (
      wc: unknown,
      permission: string,
      origin: string,
      details?: { securityOrigin?: string }
    ) => boolean
    expect(
      browserCheckHandler(null, 'hid', '', {
        securityOrigin: 'https://github.com'
      })
    ).toBe(true)

    const selectHidHandler = browserSessionOnMock.mock.calls.find(
      ([eventName]) => eventName === 'select-hid-device'
    )?.[1] as (
      event: { preventDefault: () => void },
      details: {
        deviceList: {
          deviceId: string
          collections?: { usagePage?: number }[]
        }[]
        frame: { url: string }
      },
      callback: (deviceId?: string) => void
    ) => void
    const preventDefault = vi.fn()
    const callback = vi.fn()
    selectHidHandler(
      { preventDefault },
      {
        frame: { url: 'https://github.com' },
        deviceList: [
          { deviceId: 'keyboard', collections: [{ usagePage: 1 }] },
          { deviceId: 'security-key', collections: [{ usagePage: 0xf1d0 }] }
        ]
      },
      callback
    )

    expect(preventDefault).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith('security-key')

    const selectWebAuthnHandler = browserSessionOnMock.mock.calls.find(
      ([eventName]) => eventName === 'select-webauthn-account'
    )?.[1] as (
      event: { preventDefault: () => void },
      details: { accounts: { credentialId: string }[] },
      callback: (credentialId?: string | null) => void
    ) => void
    const webAuthnCallback = vi.fn()
    selectWebAuthnHandler(
      { preventDefault: vi.fn() },
      { accounts: [{ credentialId: 'credential-1' }] },
      webAuthnCallback
    )
    expect(webAuthnCallback).toHaveBeenCalledWith('credential-1')
  })

  it('replaces the persistent browser-session download handler on re-attach', () => {
    const browserSessionOnMock = vi.fn()
    const browserSessionRemoveListenerMock = vi.fn()
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDevicePermissionHandler: setDevicePermissionHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: browserSessionOnMock,
      removeListener: browserSessionRemoveListenerMock
    })

    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)
    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    const downloadOnCalls = browserSessionOnMock.mock.calls.filter(
      ([eventName]) => eventName === 'will-download'
    )
    const downloadRemoveCalls = browserSessionRemoveListenerMock.mock.calls.filter(
      ([eventName]) => eventName === 'will-download'
    )
    expect(downloadOnCalls).toHaveLength(2)
    expect(downloadRemoveCalls).toHaveLength(2)
    expect(downloadRemoveCalls[1][1]).toBe(downloadOnCalls[0][1])
  })

  it('clears only browser guest registrations owned by the closing renderer', () => {
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDevicePermissionHandler: setDevicePermissionHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: vi.fn(),
      removeListener: vi.fn()
    })
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const closedHandler = getClosedHandlers(mainWindowOnMock).at(-1)
    expect(closedHandler).toBeTypeOf('function')
    closedHandler?.()
    expect(browserManagerUnregisterAllMock).not.toHaveBeenCalled()
    expect(browserManagerUnregisterGuestsForRendererMock).toHaveBeenCalledWith(1)
  })

  it('relays native file drops back to the sender window', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow({ send: vi.fn() })
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const channel = 'terminal:file-dropped-from-preload'
    const relayHandler = onMock.mock.calls.find(([event]) => event === channel)?.[1]
    expect(relayHandler).toBeTypeOf('function')
    expect(removeAllListenersMock).toHaveBeenCalledWith(channel)

    const payload = { paths: ['/tmp/example.txt'], target: 'editor' }
    relayHandler?.({ sender: mainWindow.webContents } as never, payload)

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('terminal:file-drop', payload)
    expect(removeListenerMock).not.toHaveBeenCalledWith(channel, relayHandler)
  })

  it('marks only the closing window graph unavailable when the window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of getClosedHandlers(mainWindowOnMock)) {
      handler()
    }

    expect(runtime.markGraphUnavailable).toHaveBeenCalledWith(1)
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('relays native file drops only from the owning renderer webContents', () => {
    const sendMock = vi.fn()
    const mainWindow = createMainWindow({ send: sendMock })

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const channel = 'terminal:file-dropped-from-preload'
    const relayHandler = onMock.mock.calls.find(([event]) => event === channel)?.[1]
    const payload = { paths: ['/tmp/a'], target: 'editor' }

    relayHandler?.({ sender: { id: 999 } }, payload)

    expect(sendMock).not.toHaveBeenCalled()

    relayHandler?.({ sender: mainWindow.webContents }, payload)

    expect(sendMock).toHaveBeenCalledWith('terminal:file-drop', payload)
  })

  it('ignores malformed native file-drop payloads from the owning renderer', () => {
    const sendMock = vi.fn()
    const mainWindow = createMainWindow({ send: sendMock })

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const channel = 'terminal:file-dropped-from-preload'
    const relayHandler = onMock.mock.calls.find(([event]) => event === channel)?.[1]

    relayHandler?.(
      { sender: mainWindow.webContents },
      { paths: ['C:\\Users\\alice\\secret.txt'], target: 'browser' }
    )
    relayHandler?.(
      { sender: mainWindow.webContents },
      { paths: ['/tmp/a'], target: 'file-explorer' }
    )

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('ignores native file drops after the owning webContents is destroyed', () => {
    const sendMock = vi.fn()
    const mainWindow = createMainWindow({ send: sendMock })

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const channel = 'terminal:file-dropped-from-preload'
    const relayHandler = onMock.mock.calls.find(([event]) => event === channel)?.[1]
    mainWindow.webContents.isDestroyed?.mockReturnValue(true)

    relayHandler?.({ sender: mainWindow.webContents }, { paths: ['/tmp/a'], target: 'editor' })

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clears the runtime notifier when the owning window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of getClosedHandlers(mainWindowOnMock)) {
      handler()
    }

    expect(runtime.markGraphUnavailable).toHaveBeenCalledWith(1)
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('keeps the registry-backed runtime notifier when an older window closes late', () => {
    const runtime = createRuntime()
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.id = 1
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), runtime as never)
    const oldClosedHandlers = getClosedHandlers(oldWindowOnMock)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
    newWindow.id = 2
    newWindow.on = newWindowOnMock
    attachMainWindowServices(newWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of oldClosedHandlers) {
      handler()
    }

    expect(runtime.setNotifier).not.toHaveBeenCalledWith(null)

    for (const handler of getClosedHandlers(newWindowOnMock)) {
      handler()
    }
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('keeps the registry-backed runtime notifier when the newest window closes first', () => {
    const runtime = createRuntime()
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.id = 1
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), runtime as never)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
    newWindow.id = 2
    newWindow.on = newWindowOnMock
    attachMainWindowServices(newWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of getClosedHandlers(newWindowOnMock)) {
      handler()
    }

    expect(runtime.markGraphUnavailable).toHaveBeenCalledWith(2)
    expect(runtime.setNotifier).not.toHaveBeenCalledWith(null)

    for (const handler of getClosedHandlers(oldWindowOnMock)) {
      handler()
    }
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('forwards runtime notifier events to the renderer', () => {
    const sendMock = vi.fn()
    const webContentsOnMock = vi.fn()
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow({
      on: webContentsOnMock,
      send: sendMock
    })
    mainWindow.isDestroyed = vi.fn(() => false)
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()
    getFocusedOrLastActiveMainWindowMock.mockReturnValue(mainWindow)

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    expect(runtime.setNotifier).toHaveBeenCalledTimes(1)
    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      worktreesChanged: (repoId: string) => void
      reposChanged: () => void
      activateWorktree: (
        repoId: string,
        worktreeId: string,
        setup?: { runnerScriptPath: string; envVars: Record<string, string> }
      ) => void
    }

    notifier.worktreesChanged('repo-1')
    notifier.reposChanged()
    notifier.activateWorktree('repo-1', 'wt-1', {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(broadcastToMainWindowsMock.mock.calls).toEqual([
      ['worktrees:changed', { repoId: 'repo-1' }],
      ['repos:changed']
    ])
    expect(runWorktreeChangeInvalidatorsMock).toHaveBeenCalledWith('repo-1')
    expect(runWorktreeChangeInvalidatorsMock.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastToMainWindowsMock.mock.invocationCallOrder[0]
    )
    expect(sendToWindowMock.mock.calls).toEqual([
      [
        mainWindow,
        'ui:activateWorktree',
        {
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          setup: {
            runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
            envVars: {
              ORCA_ROOT_PATH: '/tmp/repo',
              ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
            }
          }
        }
      ]
    ])
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('routes renderer-owned notifier events to the owning window', () => {
    const ownerWindow = createMainWindow()
    ownerWindow.id = 1
    const focusedWindow = createMainWindow()
    focusedWindow.id = 2
    const runtime = createRuntime()
    runtime.resolveOwnerWindowIdForTabId.mockImplementation((tabId: string) =>
      tabId === 'tab-owned' ? 1 : null
    )
    runtime.resolveOwnerWindowIdForPtyId.mockImplementation((ptyId: string) =>
      ptyId === 'pty-owned' ? 1 : null
    )
    getMainWindowByIdMock.mockImplementation((windowId: number) =>
      windowId === 1 ? ownerWindow : null
    )
    getFocusedOrLastActiveMainWindowMock.mockReturnValue(focusedWindow)

    attachMainWindowServices(focusedWindow as never, createStore(), runtime as never)

    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      renameTerminal: (tabId: string, title: string | null) => void
      terminalDriverChanged: (ptyId: string, driver: { kind: 'idle' }) => void
    }
    notifier.renameTerminal('tab-owned', 'Owned')
    notifier.terminalDriverChanged('pty-owned', { kind: 'idle' })

    expect(sendToWindowMock.mock.calls).toEqual([
      [ownerWindow, 'ui:renameTerminal', { tabId: 'tab-owned', title: 'Owned' }],
      [
        ownerWindow,
        'runtime:terminalDriverChanged',
        { ptyId: 'pty-owned', driver: { kind: 'idle' } }
      ]
    ])
    expect(broadcastToMainWindowsMock).not.toHaveBeenCalledWith(
      'runtime:terminalDriverChanged',
      expect.anything()
    )
  })

  it('stamps reveal-created PTY ownership before asking the renderer to create a terminal', async () => {
    const focusedWindow = createMainWindow()
    focusedWindow.id = 3
    ;(focusedWindow as unknown as { once: MockFn; removeListener: MockFn }).once = vi.fn()
    ;(focusedWindow as unknown as { once: MockFn; removeListener: MockFn }).removeListener = vi.fn()
    const runtime = createRuntime()
    getFocusedOrLastActiveMainWindowMock.mockReturnValue(focusedWindow)

    attachMainWindowServices(focusedWindow as never, createStore(), runtime as never)

    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      revealTerminalSession: (
        worktreeId: string,
        opts: { ptyId: string; title?: string; activate?: boolean }
      ) => Promise<{ tabId: string; title?: string }>
    }
    const reveal = notifier.revealTerminalSession('wt-1', {
      ptyId: 'pty-created',
      title: 'Created'
    })

    expect(runtime.registerPtyOwnerWindow).toHaveBeenCalledWith('pty-created', 3)
    const createTerminalCall = sendToWindowMock.mock.calls.find(
      ([, channel]) => channel === 'ui:createTerminal'
    )
    expect(createTerminalCall).toEqual([
      focusedWindow,
      'ui:createTerminal',
      expect.objectContaining({
        worktreeId: 'wt-1',
        ptyId: 'pty-created',
        title: 'Created'
      })
    ])

    const replyHandler = onMock.mock.calls.find(
      ([eventName]) => eventName === 'terminal:tabCreateReply'
    )?.[1] as (
      event: { sender: unknown },
      reply: { requestId: string; tabId?: string; title?: string }
    ) => void
    expect(createTerminalCall).toBeTruthy()
    const requestId = (createTerminalCall![2] as { requestId: string }).requestId
    replyHandler({ sender: focusedWindow.webContents }, { requestId, tabId: 'tab-created' })

    await expect(reveal).resolves.toEqual({
      tabId: 'tab-created',
      title: undefined
    })
  })
})
