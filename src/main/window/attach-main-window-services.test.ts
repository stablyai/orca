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
  browserManagerUnregisterAllMock,
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
  browserManagerUnregisterAllMock: vi.fn(),
  runWorktreeChangeInvalidatorsMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
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
}

function createMainWindow(extraWebContents: { on?: MockFn; send?: MockFn } = {}): MainWindowStub {
  return {
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
}

function createStore(): Store & { flush: MockFn } {
  return { flush: vi.fn() } as Store & { flush: MockFn }
}

function createRuntime(): RuntimeStub {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    markRendererReloading: vi.fn(),
    markGraphUnavailable: vi.fn()
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
    browserManagerUnregisterAllMock.mockReset()
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

  it('removes the app reload IPC handler when the owning window closes', () => {
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

    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
  })

  it('keeps a newer app reload handler when an older window closes late', () => {
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
    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
  })

  it('only allows the explicit permission allowlist', async () => {
    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1)
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

  it('clears browser guest registrations when the main window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const closedHandler = getClosedHandlers(mainWindowOnMock).at(-1)
    expect(closedHandler).toBeTypeOf('function')
    closedHandler?.()
    expect(browserManagerUnregisterAllMock).toHaveBeenCalledTimes(1)
  })

  it('removes the native file-drop relay when the main window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow({ send: vi.fn() })
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const channel = 'terminal:file-dropped-from-preload'
    const relayHandler = onMock.mock.calls.find(([event]) => event === channel)?.[1]
    expect(relayHandler).toBeTypeOf('function')
    expect(removeAllListenersMock).toHaveBeenCalledWith(channel)

    const closedHandlers = getClosedHandlers(mainWindowOnMock)
    for (const handler of closedHandlers) {
      handler()
    }

    expect(removeListenerMock).toHaveBeenCalledWith(channel, relayHandler)
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

  it('keeps a newer runtime notifier when an older window closes late', () => {
    const runtime = createRuntime()
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), runtime as never)
    const oldClosedHandlers = getClosedHandlers(oldWindowOnMock)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
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
    expect(runWorktreeChangeInvalidatorsMock).toHaveBeenCalledWith('repo-1')
    expect(runWorktreeChangeInvalidatorsMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMock.mock.invocationCallOrder[0]
    )
  })
})
