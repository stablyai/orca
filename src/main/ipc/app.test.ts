import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  execFileMock,
  destroySystemTrayMock,
  showOpenDialogMock,
  grantFloatingWorkspaceDirectoryMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  execFileMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  grantFloatingWorkspaceDirectoryMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

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

vi.mock('./floating-workspace-directory', () => ({
  ensureDefaultFloatingWorkspacePath: vi.fn(),
  grantFloatingWorkspaceDirectory: grantFloatingWorkspaceDirectoryMock,
  resolveFloatingTerminalCwd: vi.fn()
}))

import { registerAppHandlers } from './app'

describe('registerAppHandlers', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    execFileMock.mockReset()
    destroySystemTrayMock.mockReset()
    showOpenDialogMock.mockReset()
    grantFloatingWorkspaceDirectoryMock.mockReset()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
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
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify([
          { 'Bundle ID': 'com.apple.PressAndHold', InputSourceKind: 'Non Keyboard Input Method' },
          {
            'Bundle ID': 'com.apple.inputmethod.SCIM',
            'Input Mode': 'com.apple.inputmethod.SCIM.ITABC',
            InputSourceKind: 'Input Mode'
          }
        ])
      )
      return { kill: vi.fn() }
    })
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.inputmethod.SCIM.ITABC'
    )
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/plutil',
      expect.arrayContaining(['AppleSelectedInputSources']),
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('falls back to the keyboard layout when no keyboard input mode is selected', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify([
            {
              'Bundle ID': 'com.apple.PressAndHold',
              InputSourceKind: 'Non Keyboard Input Method'
            }
          ])
        )
        return { kill: vi.fn() }
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, 'com.apple.keylayout.ABC\n')
        return { kill: vi.fn() }
      })
    registerAppHandlers({} as never)

    await expect(handlers.get('app:getKeyboardInputSourceId')?.(null)).resolves.toBe(
      'com.apple.keylayout.ABC'
    )
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileMock).toHaveBeenLastCalledWith(
      '/usr/bin/defaults',
      ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('falls back when macOS keyboard input source probes never report completion', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
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
    expect(killMock).toHaveBeenCalledTimes(2)
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
