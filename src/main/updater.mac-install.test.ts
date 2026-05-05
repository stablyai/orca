import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  shellMock,
  isMock,
  killAllPtyMock
} = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.push(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

  const appEmit = (event: string, ...args: unknown[]) => {
    for (const handler of appEventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = eventHandlers.get(event) ?? []
    handlers.push(handler)
    eventHandlers.set(event, handlers)
    return autoUpdaterMock
  })

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of eventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const reset = () => {
    appEventHandlers.clear()
    appOn.mockClear()
    eventHandlers.clear()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset()
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    emit,
    reset
  }

  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: appOn,
      emit: appEmit,
      quit: vi.fn()
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [])
    },
    nativeUpdaterMock: {
      on: vi.fn()
    },
    autoUpdaterMock,
    shellMock: {
      openExternal: vi.fn()
    },
    isMock: { dev: false },
    killAllPtyMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: shellMock,
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

vi.mock('./updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

describe('updater mac install handoff', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    shellMock.openExternal.mockReset()
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.runIf(process.platform === 'darwin')(
    'waits for Squirrel.Mac before honoring a manual quit that should install the update',
    async () => {
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      // Why: the update-available handler is now async (it awaits fetchChangelog).
      // Flush microtasks so setAvailableVersion runs before update-downloaded fires.
      await new Promise((r) => setTimeout(r, 0))
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')

      nativeDownloadedHandler?.()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'downloading',
        percent: 100,
        version: '1.0.61'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'falls back to a normal quit if Squirrel.Mac never becomes ready',
    async () => {
      vi.useFakeTimers()

      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      // Why: the update-available handler is now async (it awaits fetchChangelog).
      // Flush microtasks so setAvailableVersion runs before update-downloaded fires.
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(appMock.quit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15000)

      expect(appMock.quit).toHaveBeenCalledTimes(1)

      const secondPreventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault: secondPreventDefault })
      expect(secondPreventDefault).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
  )
})
