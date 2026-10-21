import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { quit: vi.fn() } }))
vi.mock('../updater', () => ({ checkForUpdatesFromMenu: vi.fn(), isQuittingForUpdate: vi.fn() }))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../window/attach-main-window-services', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { sendOpenCrashReport, sendOpenFeatureTour, sendOpenSetupGuide } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { markNativeBrowserPopupWindow } from '../browser/native-browser-popup-windows'

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } }
}

function asBrowserWindow(window: ReturnType<typeof fakeWindow>): Electron.BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Help actions only read isDestroyed() and webContents.send from the target window.
  return window as unknown as Electron.BrowserWindow
}

describe('Help menu renderer target', () => {
  it('routes Help actions invoked from a native browser popup to the main window', () => {
    const main = fakeWindow()
    const popup = fakeWindow()
    markNativeBrowserPopupWindow(asBrowserWindow(popup))
    Object.assign(state, { mainWindow: main })

    for (const sendAction of [sendOpenFeatureTour, sendOpenSetupGuide, sendOpenCrashReport]) {
      sendAction(asBrowserWindow(popup))
    }

    expect(popup.webContents.send).not.toHaveBeenCalled()
    expect(main.webContents.send.mock.calls).toEqual([
      ['ui:openFeatureTour'],
      ['ui:openSetupGuide'],
      ['ui:openCrashReport']
    ])
  })

  it('keeps routing Help actions to the Orca window that invoked them', () => {
    const main = fakeWindow()
    const popout = fakeWindow()
    Object.assign(state, { mainWindow: main })

    sendOpenFeatureTour(asBrowserWindow(popout))

    expect(popout.webContents.send).toHaveBeenCalledWith('ui:openFeatureTour')
    expect(main.webContents.send).not.toHaveBeenCalled()
  })
})
