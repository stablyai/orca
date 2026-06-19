import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, appExitMock, appQuitMock, appRelaunchMock, execFileMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  execFileMock: vi.fn()
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
    showOpenDialog: vi.fn()
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

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
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

  it('falls back when the macOS keyboard layout probe never reports completion', async () => {
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

    await vi.advanceTimersByTimeAsync(500)

    expect(settled).toBe(true)
    await expect(resultPromise).resolves.toBeNull()
    expect(killMock).toHaveBeenCalled()
  })
})
