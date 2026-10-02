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
  registerRendererShutdownCheckpointHandlerMock,
  registerMacKeyboardLayoutChangeNotificationsMock
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

  it.each([true, false])(
    'prioritizes the selected input mode regardless of record order (%s)',
    async (modeLast) => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const inputMode = {
        'Bundle ID': 'com.apple.inputmethod.SCIM',
        'Input Mode': 'com.apple.inputmethod.SCIM.ITABC',
        InputSourceKind: 'Input Mode'
      }
      const keyboardLayout = {
        InputSourceKind: 'Keyboard Layout',
        'KeyboardLayout Name': 'ABC',
        'KeyboardLayout ID': 252
      }
      spawnMock.mockImplementation(() =>
        createFakeSpawnChild({
          stdout: JSON.stringify([
            { 'Bundle ID': 'com.apple.PressAndHold', InputSourceKind: 'Non Keyboard Input Method' },
            ...(modeLast ? [keyboardLayout, inputMode] : [inputMode, keyboardLayout])
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
    }
  )

  it('reads the layout ID only after a selected keyboard layout without a bundle ID is proved', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnMock
      .mockImplementationOnce(() =>
        createFakeSpawnChild({
          stdout: JSON.stringify([
            {
              'Bundle ID': 'com.apple.PressAndHold',
              InputSourceKind: 'Non Keyboard Input Method'
            },
            {
              InputSourceKind: 'Keyboard Layout',
              'KeyboardLayout Name': 'ABC',
              'KeyboardLayout ID': 252
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

  it.each([
    { name: 'nonzero exit', result: { code: 1 } },
    { name: 'spawn failure', result: { error: new Error('spawn ENOENT') } },
    { name: 'invalid JSON', result: { stdout: '{' } },
    { name: 'non-array JSON', result: { stdout: '{}' } },
    { name: 'empty records', result: { stdout: '[]' } },
    { name: 'unknown record', result: { stdout: '[{"InputSourceKind":"Unknown"}]' } },
    {
      name: 'unidentified input mode',
      result: { stdout: '[{"InputSourceKind":"Keyboard Layout"},{"InputSourceKind":"Input Mode"}]' }
    },
    {
      name: 'non-keyboard record',
      result: {
        stdout:
          '[{"InputSourceKind":"Non Keyboard Input Method","Bundle ID":"com.apple.PressAndHold"}]'
      }
    }
  ])('does not infer the backing layout after $name', async ({ result }) => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    spawnMock.mockImplementation(() => createFakeSpawnChild(result))
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBeNull()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('returns unknown and cleans up when the selected-source probe times out', async () => {
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
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(processKillSpy).toHaveBeenCalledTimes(1)
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
