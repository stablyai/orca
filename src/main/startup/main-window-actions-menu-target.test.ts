import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: vi.fn() }))
vi.mock('../window/workspace-space-window', () => ({ getWorkspaceSpaceWindow: vi.fn() }))
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
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { getWorkspaceSpaceWindow } from '../window/workspace-space-window'
import { safelyRevealWindow } from '../window/focus-existing-window'

function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

function asBrowserWindow(window: ReturnType<typeof fakeWindow>): Electron.BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Help routing reads only isDestroyed() and webContents.send; native presentation is mocked.
  return window as unknown as Electron.BrowserWindow
}

const helpActions = [sendOpenFeatureTour, sendOpenSetupGuide, sendOpenCrashReport]
const helpMessages = [['ui:openFeatureTour'], ['ui:openSetupGuide'], ['ui:openCrashReport']]

describe('Help menu renderer target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDashboardPopoutWindow).mockReturnValue(null)
    vi.mocked(getWorkspaceSpaceWindow).mockReturnValue(null)
    state.mainWindow = null
  })

  it.each([
    ['Dashboard', getDashboardPopoutWindow],
    ['Space', getWorkspaceSpaceWindow]
  ] as const)('routes and reveals main for Help actions from %s', (_name, getCompanion) => {
    const main = fakeWindow()
    const companion = fakeWindow()
    state.mainWindow = asBrowserWindow(main)
    vi.mocked(getCompanion).mockReturnValue(asBrowserWindow(companion))

    for (const sendAction of helpActions) {
      sendAction(asBrowserWindow(companion))
    }

    expect(companion.webContents.send).not.toHaveBeenCalled()
    expect(main.webContents.send.mock.calls).toEqual(helpMessages)
    expect(safelyRevealWindow).toHaveBeenCalledTimes(3)
    expect(safelyRevealWindow).toHaveBeenCalledWith(main)
  })

  it('routes Help from a native browser popup to main without changing presentation', () => {
    const main = fakeWindow()
    const popup = fakeWindow()
    markNativeBrowserPopupWindow(asBrowserWindow(popup))
    state.mainWindow = asBrowserWindow(main)

    for (const sendAction of helpActions) {
      sendAction(asBrowserWindow(popup))
    }

    expect(popup.webContents.send).not.toHaveBeenCalled()
    expect(main.webContents.send.mock.calls).toEqual(helpMessages)
    expect(safelyRevealWindow).not.toHaveBeenCalled()
  })

  it('keeps routing Help actions to another full Orca window that invoked them', () => {
    const main = fakeWindow()
    const other = fakeWindow()
    state.mainWindow = asBrowserWindow(main)

    for (const sendAction of helpActions) {
      sendAction(asBrowserWindow(other))
    }

    expect(other.webContents.send.mock.calls).toEqual(helpMessages)
    expect(main.webContents.send).not.toHaveBeenCalled()
    expect(safelyRevealWindow).not.toHaveBeenCalled()
  })

  it.each([null, undefined])('falls back to live main for missing target %s', (target) => {
    const main = fakeWindow()
    state.mainWindow = asBrowserWindow(main)

    sendOpenFeatureTour(target)

    expect(main.webContents.send).toHaveBeenCalledWith('ui:openFeatureTour')
    expect(safelyRevealWindow).not.toHaveBeenCalled()
  })

  it('falls back from a destroyed invoking window', () => {
    const main = fakeWindow()
    const target = fakeWindow(true)
    state.mainWindow = asBrowserWindow(main)

    sendOpenSetupGuide(asBrowserWindow(target))

    expect(target.webContents.send).not.toHaveBeenCalled()
    expect(main.webContents.send).toHaveBeenCalledWith('ui:openSetupGuide')
  })

  it.each([false, true])(
    'ignores missing or destroyed main for companion actions (%s)',
    (destroyed) => {
      const main = fakeWindow(true)
      const companion = fakeWindow()
      state.mainWindow = destroyed ? asBrowserWindow(main) : null
      vi.mocked(getDashboardPopoutWindow).mockReturnValue(asBrowserWindow(companion))

      for (const sendAction of helpActions) {
        sendAction(asBrowserWindow(companion))
      }

      expect(main.webContents.send).not.toHaveBeenCalled()
      expect(companion.webContents.send).not.toHaveBeenCalled()
      expect(safelyRevealWindow).not.toHaveBeenCalled()
    }
  )
})
