import { describe, expect, it, vi } from 'vitest'

const { loadAutoUpdaterMock, showMessageBoxMock, trustedWindow } = vi.hoisted(() => ({
  loadAutoUpdaterMock: vi.fn(),
  showMessageBoxMock: vi.fn(() => Promise.resolve({ response: 0 })),
  trustedWindow: { isDestroyed: () => false }
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', on: vi.fn(), prependListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: showMessageBoxMock },
  powerMonitor: { on: vi.fn() }
}))

vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: loadAutoUpdaterMock }))

vi.mock('../ipc/ui', () => ({ getTrustedUIRendererWindow: () => trustedWindow }))

describe('Zotz updater policy', () => {
  it('never reaches electron-updater when updates are turned off in settings', async () => {
    const updater = await import('./updater-service')
    const { applyZotzUpdaterSetting } = await import('./zotz-updater-policy')
    applyZotzUpdaterSetting({ zotzUpdatesEnabled: false })

    updater.setupAutoUpdater(null)
    updater.checkForUpdates()
    updater.checkForUpdatesFromMenu()
    updater.downloadUpdate()
    updater.quitAndInstall()

    expect(loadAutoUpdaterMock).not.toHaveBeenCalled()
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      trustedWindow,
      expect.objectContaining({ message: 'Zotz updates are turned off.' })
    )
    expect(() => updater.checkForRemoteServerUpdate('runtime-1')).toThrow(
      'remote_update_manual_required'
    )
    await expect(updater.listAvailableReleaseBuilds('stable')).resolves.toEqual([])
  })
})
