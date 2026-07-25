import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  spawnMock,
  destroySystemTrayMock,
  relaunchAppMock,
  showOpenDialogMock,
  grantFloatingWorkspaceDirectoryMock,
  registerRendererShutdownCheckpointHandlerMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  spawnMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  grantFloatingWorkspaceDirectoryMock: vi.fn(),
  registerRendererShutdownCheckpointHandlerMock: vi.fn()
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
    fromWebContents: vi.fn(() => null)
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
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

import { registerAppHandlers } from './app'

describe('registerAppHandlers', () => {
  const originalPlatform = process.platform
  // Why: readCommandStdout process-group-kills on timeout; stub the real signal
  // so a fake child pid can never target a live process group during tests.
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
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
  })

  it('marks relaunch as expected shutdown before exiting', async () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.(null))

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

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.(null))

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
})
