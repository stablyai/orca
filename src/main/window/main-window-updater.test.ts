import { beforeEach, describe, expect, it, vi } from 'vitest'

const { applyProxySettingsMock, fromPartitionMock, setupAutoUpdaterMock } = vi.hoisted(() => ({
  applyProxySettingsMock: vi.fn(),
  fromPartitionMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  session: { fromPartition: fromPartitionMock }
}))
vi.mock('../ipc/ui', () => ({ isTrustedUIRenderer: vi.fn(() => true) }))
vi.mock('../startup/startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyProxySettingsMock
}))
vi.mock('../updater', () => ({
  checkForUpdatesFromMenu: vi.fn(),
  dismissAvailableUpdate: vi.fn(),
  dismissNudge: vi.fn(),
  downloadUpdate: vi.fn(),
  getLinuxPackageInstallInstructions: vi.fn(),
  getUpdateStatus: vi.fn(),
  listAvailableReleaseBuilds: vi.fn(),
  quitAndInstall: vi.fn(),
  setupAutoUpdater: setupAutoUpdaterMock,
  showLinuxPackage: vi.fn()
}))

import { scheduleMainWindowAutoUpdaterSetup } from './main-window-updater'

describe('scheduleMainWindowAutoUpdaterSetup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    applyProxySettingsMock.mockReset()
    fromPartitionMock.mockReset()
    setupAutoUpdaterMock.mockReset()
  })

  it('applies the app proxy to the updater session before setup completes', async () => {
    const proxySession = { setProxy: vi.fn() }
    const applyProxy = Promise.withResolvers()
    fromPartitionMock.mockReturnValue(proxySession)
    applyProxySettingsMock.mockReturnValue(applyProxy.promise)
    let readyToShow: (() => void) | undefined
    const mainWindow = {
      isDestroyed: () => false,
      once: vi.fn((_event: string, callback: () => void) => {
        readyToShow = callback
      })
    }
    const settings = { httpProxyUrl: 'http://proxy.example:8080' }
    const store = {
      getSettings: () => settings,
      getUI: () => ({ lastUpdateCheckAt: Date.now() }),
      flushPendingAsync: vi.fn(),
      updateUI: vi.fn()
    }

    scheduleMainWindowAutoUpdaterSetup(mainWindow as never, store as never)
    readyToShow?.()
    await vi.runOnlyPendingTimersAsync()

    expect(fromPartitionMock).toHaveBeenCalledWith('electron-updater', { cache: false })
    expect(applyProxySettingsMock).toHaveBeenCalledWith(settings, { proxySession })
    expect(setupAutoUpdaterMock).not.toHaveBeenCalled()

    applyProxy.resolve(undefined)
    await vi.runAllTimersAsync()

    expect(setupAutoUpdaterMock).toHaveBeenCalledTimes(1)
  })
})
