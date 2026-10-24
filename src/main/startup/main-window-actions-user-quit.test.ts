import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ quit: vi.fn() }))
type FakeWindow = { isDestroyed: () => boolean; close: () => void }
const popout = vi.hoisted((): { window: FakeWindow | null } => ({ window: null }))

vi.mock('electron', () => ({ app: { quit: electron.quit } }))
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
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => popout.window
}))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { quitFromUserCommand, showMainWindowFromTray } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { consumeUserQuitWindowClose } from '../window/user-quit-window-close'
import { safelyRevealWindow } from '../window/focus-existing-window'
import {
  isWindowlessLaunch,
  resetAcceptedUserForegroundForTests
} from '../window/foreground-activation-policy'

function fakeWindow() {
  return { isDestroyed: () => false, close: vi.fn<() => void>() }
}

describe('quitFromUserCommand', () => {
  beforeEach(() => {
    electron.quit.mockReset()
    state.isQuitting = false
    popout.window = null
    resetAcceptedUserForegroundForTests()
    vi.unstubAllEnvs()
  })

  it('only closes the desktop windows of an `orca serve` host (#15537)', () => {
    const main = fakeWindow()
    const dashboard = fakeWindow()
    popout.window = dashboard
    state.isServeMode = true
    Object.assign(state, { mainWindow: main })

    quitFromUserCommand()

    expect(electron.quit).not.toHaveBeenCalled()
    expect(state.isQuitting).toBe(false)
    expect(main.close).toHaveBeenCalledOnce()
    expect(dashboard.close).toHaveBeenCalledOnce()
    // The main window's close carries the user-Quit intent that arms the frozen-renderer deadline.
    expect(consumeUserQuitWindowClose(main)).toBe(true)
  })

  it('tray open presents a background launch before revealing the window', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    resetAcceptedUserForegroundForTests()
    const main = fakeWindow()
    Object.assign(state, { mainWindow: main })
    expect(isWindowlessLaunch()).toBe(true)

    showMainWindowFromTray()

    expect(isWindowlessLaunch()).toBe(false)
    expect(safelyRevealWindow).toHaveBeenCalledWith(main)
  })

  it('quits a desktop app as before', () => {
    state.isServeMode = false
    Object.assign(state, { mainWindow: fakeWindow() })

    quitFromUserCommand()

    expect(electron.quit).toHaveBeenCalledOnce()
    expect(state.isQuitting).toBe(true)
  })
})
