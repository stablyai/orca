import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  onMock,
  removeAllListenersMock,
  setPermissionRequestHandlerMock,
  setPermissionCheckHandlerMock,
  setDisplayMediaRequestHandlerMock,
  systemPreferencesAskForMediaAccessMock,
  systemPreferencesGetMediaAccessStatusMock,
  registerRepoHandlersMock,
  registerWorktreeHandlersMock,
  registerPtyHandlersMock,
  setupAutoUpdaterMock,
  sessionFromPartitionMock,
  browserManagerUnregisterAllMock,
  browserManagerNotifyPermissionDeniedMock,
  browserManagerHandleGuestWillDownloadMock
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
  setPermissionCheckHandlerMock: vi.fn(),
  setDisplayMediaRequestHandlerMock: vi.fn(),
  systemPreferencesAskForMediaAccessMock: vi.fn(),
  systemPreferencesGetMediaAccessStatusMock: vi.fn(),
  registerRepoHandlersMock: vi.fn(),
  registerWorktreeHandlersMock: vi.fn(),
  registerPtyHandlersMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  browserManagerUnregisterAllMock: vi.fn(),
  browserManagerNotifyPermissionDeniedMock: vi.fn(),
  browserManagerHandleGuestWillDownloadMock: vi.fn()
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
    removeHandler: vi.fn(),
    handle: vi.fn()
  }
}))

vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: registerRepoHandlersMock
}))

vi.mock('../ipc/worktrees', () => ({
  registerWorktreeHandlers: registerWorktreeHandlersMock
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(),
  registerPtyHandlers: registerPtyHandlersMock
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    notifyPermissionDenied: browserManagerNotifyPermissionDeniedMock,
    handleGuestWillDownload: browserManagerHandleGuestWillDownloadMock,
    unregisterAll: browserManagerUnregisterAllMock
  }
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
  isDestroyed?: MockFn
  on: MockFn
  webContents: {
    on: MockFn
    send?: MockFn
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
}

function createMainWindow(extraWebContents: { on?: MockFn; send?: MockFn } = {}): MainWindowStub {
  return {
    on: vi.fn(),
    webContents: {
      on: vi.fn(),
      session: {
        setPermissionRequestHandler: setPermissionRequestHandlerMock,
        setPermissionCheckHandler: setPermissionCheckHandlerMock
      },
      ...extraWebContents
    }
  }
}

function createStore(): never {
  return { flush: vi.fn() } as never
}

function createRuntime(): RuntimeStub {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    markRendererReloading: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
}

describe('attachMainWindowServices', () => {
  beforeEach(() => {
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    setPermissionRequestHandlerMock.mockReset()
    setPermissionCheckHandlerMock.mockReset()
    setDisplayMediaRequestHandlerMock.mockReset()
    systemPreferencesAskForMediaAccessMock.mockReset()
    systemPreferencesGetMediaAccessStatusMock.mockReset()
    registerRepoHandlersMock.mockReset()
    registerWorktreeHandlersMock.mockReset()
    registerPtyHandlersMock.mockReset()
    setupAutoUpdaterMock.mockReset()
    sessionFromPartitionMock.mockReset()
    browserManagerUnregisterAllMock.mockReset()
    browserManagerNotifyPermissionDeniedMock.mockReset()
    browserManagerHandleGuestWillDownloadMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: vi.fn()
    })
    systemPreferencesAskForMediaAccessMock.mockResolvedValue(true)
    systemPreferencesGetMediaAccessStatusMock.mockReturnValue('granted')
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
      permissionHandler(null, 'media', callback, { mediaTypes: ['audio', 'video'] })

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
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: browserSessionOnMock
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
    const guestWc = { id: 401, getURL: vi.fn(() => 'https://example.com/account') }
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
    expect(displayCb).toHaveBeenCalledWith({ video: undefined, audio: undefined })

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

  it('clears browser guest registrations when the main window closes', () => {
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
      on: vi.fn()
    })
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const closedHandler = mainWindowOnMock.mock.calls
      .filter(([event]) => event === 'closed')
      .at(-1)?.[1] as (() => void) | undefined
    expect(closedHandler).toBeTypeOf('function')
    closedHandler?.()
    expect(browserManagerUnregisterAllMock).toHaveBeenCalledTimes(1)
  })

  it('forwards runtime notifier events to the renderer', () => {
    const sendMock = vi.fn()
    const webContentsOnMock = vi.fn()
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow({ on: webContentsOnMock, send: sendMock })
    mainWindow.isDestroyed = vi.fn(() => false)
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()

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

    expect(sendMock.mock.calls).toEqual([
      ['worktrees:changed', { repoId: 'repo-1' }],
      ['repos:changed'],
      [
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
  })
})
