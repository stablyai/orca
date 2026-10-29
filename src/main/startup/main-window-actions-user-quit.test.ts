import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ quit: vi.fn() }))
type FakeWindow = { isDestroyed: () => boolean; close: () => void }
const popout = vi.hoisted((): { window: FakeWindow | null } => ({ window: null }))
const workers = vi.hoisted(
  (): {
    windows: FakeWindow[]
    close: ReturnType<typeof vi.fn<() => Promise<boolean>>>
    forget: ReturnType<typeof vi.fn>
  } => ({
    windows: [],
    close: vi.fn(async () => true),
    forget: vi.fn()
  })
)

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
vi.mock('../window/worker-window', () => ({
  getWorkerWindows: () => workers.windows,
  closeWorkerWindowsForUserQuit: workers.close,
  forgetRetainedHostWindow: workers.forget
}))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn()
}))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))
vi.mock('../window/renderer-launch-failure-probe', () => ({ probeRendererLaunchCapacity: vi.fn() }))

import { quitFromUserCommand } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { consumeUserQuitWindowClose } from '../window/user-quit-window-close'

function fakeWindow() {
  return { isDestroyed: () => false, close: vi.fn<() => void>() }
}

describe('quitFromUserCommand', () => {
  beforeEach(() => {
    electron.quit.mockReset()
    state.isQuitting = false
    popout.window = null
    workers.windows = []
    workers.close.mockReset().mockResolvedValue(true)
    workers.forget.mockReset()
  })

  it('only closes the desktop windows of an `orca serve` host (#15537)', async () => {
    const main = fakeWindow()
    const dashboard = fakeWindow()
    const worker = fakeWindow()
    popout.window = dashboard
    workers.windows = [worker]
    state.isServeMode = true
    Object.assign(state, { mainWindow: main })

    quitFromUserCommand()
    await vi.waitFor(() => expect(main.close).toHaveBeenCalledOnce())

    expect(electron.quit).not.toHaveBeenCalled()
    expect(state.isQuitting).toBe(false)
    expect(main.close).toHaveBeenCalledOnce()
    expect(dashboard.close).toHaveBeenCalledOnce()
    expect(workers.close).toHaveBeenCalledOnce()
    expect(consumeUserQuitWindowClose(main)).toBe(true)
  })

  it('keeps the serve host alive when a worker vetoes Quit', async () => {
    const main = fakeWindow()
    workers.windows = [fakeWindow()]
    workers.close.mockResolvedValue(false)
    state.isServeMode = true
    Object.assign(state, { mainWindow: main })

    quitFromUserCommand()
    await vi.waitFor(() => expect(workers.close).toHaveResolvedWith(false))

    expect(main.close).not.toHaveBeenCalled()
    expect(electron.quit).not.toHaveBeenCalled()
    expect(workers.forget).toHaveBeenCalledWith(main)
  })

  it('quits a desktop app as before', () => {
    state.isServeMode = false
    Object.assign(state, { mainWindow: fakeWindow() })

    quitFromUserCommand()

    expect(electron.quit).toHaveBeenCalledOnce()
    expect(state.isQuitting).toBe(true)
  })
})
