import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  ipcMainListeners,
  getAllWindowsMock,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  spawnMock,
  destroySystemTrayMock,
  relaunchAppMock,
  showOpenDialogMock,
  grantFloatingWorkspaceDirectoryMock,
  registerRendererShutdownCheckpointHandlerMock,
  registerMacKeyboardLayoutChangeNotificationsMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  ipcMainListeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  getAllWindowsMock: vi.fn<() => unknown[]>(() => []),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  spawnMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  grantFloatingWorkspaceDirectoryMock: vi.fn(),
  registerRendererShutdownCheckpointHandlerMock: vi.fn(),
  registerMacKeyboardLayoutChangeNotificationsMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

// Fakes the detached `spawn` child: a stdout EventEmitter plus close/error
// events, so tests drive the async command lifecycle readCommandStdout expects.
function createFakeSpawnChild(options: {
  stdout?: string
  code?: number
  error?: Error
  pid?: number
  hang?: boolean
}): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter } {
  const { stdout, code = 0, error, pid = 4242, hang = false } = options
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  }
  child.pid = pid
  child.kill = vi.fn()
  const stdoutStream = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>
  }
  stdoutStream.setEncoding = vi.fn()
  child.stdout = stdoutStream
  if (!hang) {
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error)
        return
      }
      if (stdout !== undefined) {
        stdoutStream.emit('data', stdout)
      }
      child.emit('close', code)
    })
  }
  return child
}

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    getAppPath: vi.fn(() => '/test/app'),
    isPackaged: false,
    quit: appQuitMock,
    relaunch: appRelaunchMock
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: getAllWindowsMock
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => unknown) => {
      ipcMainListeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string) => {
      ipcMainListeners.delete(channel)
    })
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock
}))

vi.mock('../app-relaunch', () => ({
  relaunchApp: relaunchAppMock
}))

vi.mock('./floating-workspace-directory', () => ({
  ensureDefaultFloatingWorkspacePath: vi.fn(),
  grantFloatingWorkspaceDirectory: grantFloatingWorkspaceDirectoryMock,
  resolveFloatingTerminalCwd: vi.fn()
}))

vi.mock('./renderer-shutdown-checkpoint', () => ({
  registerRendererShutdownCheckpointHandler: registerRendererShutdownCheckpointHandlerMock
}))

vi.mock('./macos-keyboard-layout-change-notifications', () => ({
  registerMacKeyboardLayoutChangeNotifications: registerMacKeyboardLayoutChangeNotificationsMock
}))

const windowsProbes = vi.hoisted(() => ({
  isWslAvailable: vi.fn(() => true),
  isWslAvailableAsync: vi.fn(async () => true),
  listWslDistros: vi.fn(() => ['Ubuntu']),
  listWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  isPwshAvailable: vi.fn(() => true),
  isPwshAvailableAsync: vi.fn(async () => true)
}))

vi.mock('../wsl', () => ({
  isWslAvailable: windowsProbes.isWslAvailable,
  isWslAvailableAsync: windowsProbes.isWslAvailableAsync,
  listWslDistros: windowsProbes.listWslDistros,
  listWslDistrosAsync: windowsProbes.listWslDistrosAsync
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: windowsProbes.isPwshAvailable,
  isPwshAvailableAsync: windowsProbes.isPwshAvailableAsync
}))

import { registerAppHandlers } from './app'
import { registerRendererPreloadWindow } from '../window/renderer-preload-window-registry'

describe('registerAppHandlers', () => {
  const originalPlatform = process.platform
  // Why: readCommandStdout process-group-kills on timeout; stub the real signal
  // so a fake child pid can never target a live process group during tests.
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    ipcMainListeners.clear()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    spawnMock.mockReset()
    destroySystemTrayMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    showOpenDialogMock.mockReset()
    grantFloatingWorkspaceDirectoryMock.mockReset()
    registerRendererShutdownCheckpointHandlerMock.mockReset()
    registerMacKeyboardLayoutChangeNotificationsMock.mockReset()
    for (const probe of Object.values(windowsProbes)) {
      probe.mockClear()
    }
    processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  afterEach(() => {
    processKillSpy.mockRestore()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('registers the combined renderer shutdown checkpoint', () => {
    const store = {}

    registerAppHandlers(store as never)

    expect(registerRendererShutdownCheckpointHandlerMock).toHaveBeenCalledWith(store)
    expect(registerMacKeyboardLayoutChangeNotificationsMock).toHaveBeenCalledOnce()
  })

  it('marks relaunch as expected shutdown before exiting', async () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))

    // Why: with no other windows to prepare, cleanup starts on the next microtask.
    await vi.advanceTimersByTimeAsync(0)
    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(destroySystemTrayMock).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).toHaveBeenCalledWith('renderer-request')
    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
    expect(destroySystemTrayMock.mock.invocationCallOrder[0]).toBeLessThan(
      appExitMock.mock.invocationCallOrder[0]
    )
  })

  it('waits for pre-relaunch cleanup before exiting', async () => {
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))

    await vi.advanceTimersByTimeAsync(0)
    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    finishCleanup()
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('schedules a single relaunch exit no matter how many surfaces invoke it', async () => {
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    registerAppHandlers({} as never, { onBeforeRelaunch })

    // Two surfaces (error-boundary Restart, hydration toast) can race a relaunch;
    // they must join the same checkpoint as well as the same replacement exit.
    const first = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    const second = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).not.toHaveBeenCalled()

    finishCleanup()
    await Promise.all([first, second])
    const third = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await third
    await vi.advanceTimersByTimeAsync(150)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledTimes(1)
  })

  // Fake BrowserWindow for the pre-relaunch preparation handshake.
  type FakeRelaunchWindow = {
    isDestroyed: () => boolean
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  }

  function createFakeRelaunchWindow(id: number): FakeRelaunchWindow {
    const win: FakeRelaunchWindow = {
      isDestroyed: () => false,
      webContents: { id, isDestroyed: () => false, send: vi.fn() }
    }
    // Why: preparation only handshakes windows registered as running the Orca preload.
    registerRendererPreloadWindow(win.webContents as never)
    return win
  }

  /** e.g. an offscreen browser-backend window: no Orca preload, can never answer. */
  function createFakePreloadlessWindow(id: number): FakeRelaunchWindow {
    return {
      isDestroyed: () => false,
      webContents: { id, isDestroyed: () => false, send: vi.fn() }
    }
  }

  function sentPrepareRequest(win: FakeRelaunchWindow): { requestId: number } {
    const call = win.webContents.send.mock.calls.find(
      ([channel]) => channel === 'app:relaunch-prepare'
    )
    expect(call).toBeDefined()
    return call?.[1] as { requestId: number }
  }

  function replyToPrepare(windowId: number, requestId: number, ok: boolean): void {
    ipcMainListeners.get('app:relaunch-prepare-reply')?.(
      { sender: { id: windowId } },
      {
        requestId,
        ok
      }
    )
  }

  it('prepares the other windows before a relaunch invoked from a popout exits', async () => {
    const onBeforeRelaunch = vi.fn()
    const invoker = createFakeRelaunchWindow(1)
    const mainWindow = createFakeRelaunchWindow(2)
    getAllWindowsMock.mockReturnValue([invoker, mainWindow])
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)

    // Why: the invoking preload already prepared its own document.
    expect(invoker.webContents.send).not.toHaveBeenCalled()
    const request = sentPrepareRequest(mainWindow)

    // Nothing may tear down before the other window confirms its backup.
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).not.toHaveBeenCalled()

    replyToPrepare(2, request.requestId, true)
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('keeps the app open and re-arms when a window refuses its pre-relaunch checkpoint', async () => {
    const onBeforeRelaunch = vi.fn()
    const invoker = createFakeRelaunchWindow(1)
    const mainWindow = createFakeRelaunchWindow(2)
    getAllWindowsMock.mockReturnValue([invoker, mainWindow])
    registerAppHandlers({} as never, { onBeforeRelaunch })

    let relaunchError: unknown = null
    const relaunchPromise = Promise.resolve(
      handlers.get('app:relaunch')?.({ sender: { id: 1 } })
    ).catch((error: unknown) => {
      relaunchError = error
    })
    await vi.advanceTimersByTimeAsync(0)
    const request = sentPrepareRequest(mainWindow)

    replyToPrepare(2, request.requestId, false)
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(relaunchError).toBeInstanceOf(Error)
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()
    // Why: the refusing window (and any prepared sibling) must release its restart latch.
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('app:relaunch-prepare-abort')

    // A retry runs a fresh preparation instead of joining the rejected round.
    const retryPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    const retryCall = mainWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'app:relaunch-prepare'
    )
    expect(retryCall).toHaveLength(2)
    const retryRequest = retryCall[1][1] as { requestId: number }
    replyToPrepare(2, retryRequest.requestId, true)
    await retryPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('degrades to an unprepared relaunch when a window never answers the handshake', async () => {
    const onBeforeRelaunch = vi.fn()
    const invoker = createFakeRelaunchWindow(1)
    const unresponsive = createFakeRelaunchWindow(2)
    getAllWindowsMock.mockReturnValue([invoker, unresponsive])
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(onBeforeRelaunch).not.toHaveBeenCalled()

    // Why: a hung renderer must not pin every future relaunch open.
    await vi.advanceTimersByTimeAsync(5_000)
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('re-arms the relaunch singleflight when the exit pair throws', async () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })
    destroySystemTrayMock.mockImplementationOnce(() => {
      throw new Error('tray teardown failed')
    })

    await Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).not.toHaveBeenCalled()

    // Why: a settled no-op promise would make every retry resolve instantly.
    await Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(150)

    expect(relaunchAppMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('broadcasts the prepare abort to prepared windows when the exit pair throws', async () => {
    const onBeforeRelaunch = vi.fn()
    const invoker = createFakeRelaunchWindow(1)
    const mainWindow = createFakeRelaunchWindow(2)
    getAllWindowsMock.mockReturnValue([invoker, mainWindow])
    registerAppHandlers({} as never, { onBeforeRelaunch })
    destroySystemTrayMock.mockImplementationOnce(() => {
      throw new Error('tray teardown failed')
    })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    const request = sentPrepareRequest(mainWindow)
    replyToPrepare(2, request.requestId, true)
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).not.toHaveBeenCalled()

    // Why: the prepared window latched its restart bypass and froze its shutdown
    // checkpoint; only this abort releases them — non-invokers have no self-heal.
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('app:relaunch-prepare-abort')
    // Why: the invoker's relaunch invoke already resolved, so this abort is what
    // releases it before its 5s settle grace.
    expect(invoker.webContents.send).toHaveBeenCalledWith('app:relaunch-prepare-abort')

    // A retry must run a fresh preparation round so the window re-stages state.
    const retryPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    const prepareCalls = mainWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'app:relaunch-prepare'
    )
    expect(prepareCalls).toHaveLength(2)
    replyToPrepare(2, (prepareCalls[1][1] as { requestId: number }).requestId, true)
    await retryPromise
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('never registers a second replacement instance when app.exit throws after relaunch', async () => {
    registerAppHandlers({} as never, { onBeforeRelaunch: vi.fn() })
    appExitMock.mockImplementationOnce(() => {
      throw new Error('exit failed')
    })

    await Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).toHaveBeenCalledTimes(1)

    await Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(150)

    // Why: a second app.relaunch() would register two replacement instances.
    expect(relaunchAppMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledTimes(2)
  })

  it('excludes preload-less windows from the handshake instead of stalling into the degrade', async () => {
    const onBeforeRelaunch = vi.fn()
    const invoker = createFakeRelaunchWindow(1)
    const mainWindow = createFakeRelaunchWindow(2)
    const offscreen = createFakePreloadlessWindow(99)
    getAllWindowsMock.mockReturnValue([invoker, mainWindow, offscreen])
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.({ sender: { id: 1 } }))
    await vi.advanceTimersByTimeAsync(0)

    // Why: a window with no Orca preload can never answer; asking it would stall
    // every relaunch the full 5s and then exit through the unprepared degrade.
    expect(offscreen.webContents.send).not.toHaveBeenCalled()

    const request = sentPrepareRequest(mainWindow)
    replyToPrepare(2, request.requestId, true)
    await relaunchPromise
    // Why: well under the 5s unresponsive timeout — the exit must not wait on it.
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('marks restart as expected shutdown before quitting through the normal pipeline', async () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const restartPromise = Promise.resolve(handlers.get('app:restart')?.(null))

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    await restartPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).toHaveBeenCalledWith('admin-restart')
    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('waits for pre-relaunch cleanup before restarting through the normal pipeline', async () => {
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const restartPromise = Promise.resolve(handlers.get('app:restart')?.(null))

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()

    finishCleanup()
    await restartPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('returns the selected macOS input mode before the keyboard layout fallback', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnMock.mockImplementation(() =>
      createFakeSpawnChild({
        stdout: JSON.stringify([
          { 'Bundle ID': 'com.apple.PressAndHold', InputSourceKind: 'Non Keyboard Input Method' },
          {
            'Bundle ID': 'com.apple.inputmethod.SCIM',
            'Input Mode': 'com.apple.inputmethod.SCIM.ITABC',
            InputSourceKind: 'Input Mode'
          }
        ])
      })
    )
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.inputmethod.SCIM.ITABC'
    )
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // Why: macOS 15's `plutil -extract <key> json` aborts on the input-source
    // array, so the probe reads live cfprefsd via `defaults export` and dodges
    // the bug with an xml1 extract before converting the clean subtree to JSON.
    // Pin the exact pipeline (absolute paths, stdin markers) so dropping any
    // stage silently regressing CJK detection to the fallback fails the test.
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-c',
        '/usr/bin/defaults export com.apple.HIToolbox - | ' +
          '/usr/bin/plutil -extract AppleSelectedInputSources xml1 -o - - | ' +
          '/usr/bin/plutil -convert json -o - -'
      ],
      expect.objectContaining({ detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    )
  })

  it('falls back to the keyboard layout when no keyboard input mode is selected', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnMock
      .mockImplementationOnce(() =>
        createFakeSpawnChild({
          stdout: JSON.stringify([
            {
              'Bundle ID': 'com.apple.PressAndHold',
              InputSourceKind: 'Non Keyboard Input Method'
            }
          ])
        })
      )
      .mockImplementationOnce(() => createFakeSpawnChild({ stdout: 'com.apple.keylayout.ABC\n' }))
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.keylayout.ABC'
    )
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/usr/bin/defaults',
      ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
      expect.objectContaining({ detached: true })
    )
  })

  it('falls back to the keyboard layout when the selected input source probe exits non-zero', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    // Why: reproduces macOS 15's `plutil` abort — the pipeline exits non-zero, so
    // the probe rejects on the `close` branch and the handler falls back.
    spawnMock
      .mockImplementationOnce(() => createFakeSpawnChild({ code: 1 }))
      .mockImplementationOnce(() => createFakeSpawnChild({ stdout: 'com.apple.keylayout.ABC\n' }))
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.keylayout.ABC'
    )
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/usr/bin/defaults',
      ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
      expect.objectContaining({ detached: true })
    )
  })

  it('falls back to the keyboard layout when the selected input source probe fails to spawn', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    // Why: a spawn-level failure (ENOENT/EACCES) emits 'error'; the handler must
    // still fall back rather than reject out of the IPC call.
    spawnMock
      .mockImplementationOnce(() => createFakeSpawnChild({ error: new Error('spawn ENOENT') }))
      .mockImplementationOnce(() => createFakeSpawnChild({ stdout: 'com.apple.keylayout.ABC\n' }))
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.keylayout.ABC'
    )
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('falls back when macOS keyboard input source probes never report completion', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnMock.mockImplementation(() => createFakeSpawnChild({ pid: 4242, hang: true }))
    registerAppHandlers({} as never)

    const handler = handlers.get('app:getKeyboardInputSourceId')
    expect(handler).toBeDefined()
    let settled = false
    const resultPromise = Promise.resolve(handler?.(null)).then((result) => {
      settled = true
      return result
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toBe(true)
    await expect(resultPromise).resolves.toBeNull()
    // Why: both wedged probes get a process-group SIGKILL (negative pid) so the
    // shell and any orphaned `defaults`/`plutil` stages are reaped on timeout.
    expect(processKillSpy).toHaveBeenCalledTimes(2)
    expect(processKillSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')
  })

  it('picks an existing floating workspace directory without enabling native directory creation', async () => {
    const store = {}
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/kaylee/notes']
    })
    registerAppHandlers(store as never)

    await expect(
      handlers.get('app:pickFloatingWorkspaceDirectory')?.({ sender: {} })
    ).resolves.toBe('/Users/kaylee/notes')
    expect(showOpenDialogMock).toHaveBeenCalledWith({
      properties: ['openDirectory']
    })
    expect(grantFloatingWorkspaceDirectoryMock).toHaveBeenCalledWith(store, '/Users/kaylee/notes')
  })

  // Why: the renderer reads these on every Windows capability refresh; the sync probes
  // execFileSync wsl.exe/pwsh.exe and would stall the main event loop for up to 5s each.
  it('answers the Windows shell capability channels without a blocking spawn', async () => {
    registerAppHandlers({} as never)

    await expect(handlers.get('wsl:isAvailable')?.(null)).resolves.toBe(true)
    await expect(handlers.get('wsl:listDistros')?.(null)).resolves.toEqual(['Ubuntu'])
    await expect(handlers.get('pwsh:isAvailable')?.(null)).resolves.toBe(true)

    expect(windowsProbes.isWslAvailableAsync).toHaveBeenCalledTimes(1)
    expect(windowsProbes.listWslDistrosAsync).toHaveBeenCalledTimes(1)
    expect(windowsProbes.isPwshAvailableAsync).toHaveBeenCalledTimes(1)
    expect(windowsProbes.isWslAvailable).not.toHaveBeenCalled()
    expect(windowsProbes.listWslDistros).not.toHaveBeenCalled()
    expect(windowsProbes.isPwshAvailable).not.toHaveBeenCalled()
  })
})
