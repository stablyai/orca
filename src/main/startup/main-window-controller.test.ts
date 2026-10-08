import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: { mainWindow: { isDestroyed: () => boolean } | null } = { mainWindow: null }
  return {
    state,
    requireServices: vi.fn(),
    createWindow: vi.fn(),
    logStartup: vi.fn()
  }
})

vi.mock('electron', () => ({ app: {} }))
vi.mock('./main-process-state', () => ({ mainProcessState: mocks.state }))
vi.mock('./main-window-service-readiness', () => ({
  requireMainWindowServices: mocks.requireServices
}))
vi.mock('../window/createMainWindow', () => ({ createMainWindow: mocks.createWindow }))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: mocks.logStartup }))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({}))
vi.mock('../crash-reporting/process-gone-classification', () => ({}))
vi.mock('../telemetry/consent', () => ({}))
vi.mock('../telemetry/client', () => ({}))
vi.mock('./windows-user-data-acl', () => ({}))
vi.mock('./windows-install-dir-acl-probe', () => ({}))
vi.mock('./windows-install-dir-acl-recovery', () => ({}))
vi.mock('../window/main-window-visibility', () => ({}))
vi.mock('../tray/system-tray', () => ({}))
vi.mock('./main-window-actions', () => ({}))
vi.mock('./main-window-core-services', () => ({}))
vi.mock('./main-window-agent-status', () => ({}))
vi.mock('./main-window-lifecycle-flags', () => ({}))
vi.mock('./gpu-lifecycle', () => ({}))
vi.mock('./branch-rename-hook', () => ({}))
vi.mock('./synthetic-title-runtime', () => ({}))

import { openMainWindow } from './main-window-controller'

describe('main window ownership during startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.mainWindow = null
    mocks.requireServices.mockImplementation(() => {
      throw new Error('startup services not ready')
    })
  })

  it('reuses a window opened by activation before deferred startup resumes', () => {
    const window = { isDestroyed: () => false }
    mocks.state.mainWindow = window

    expect(openMainWindow({ revealOnDidFinishLoad: true })).toBe(window)
    expect(openMainWindow()).toBe(window)
    expect(mocks.requireServices).not.toHaveBeenCalled()
    expect(mocks.createWindow).not.toHaveBeenCalled()
    expect(mocks.logStartup).not.toHaveBeenCalled()
  })

  it.each([null, { isDestroyed: () => true }])(
    'still checks startup readiness when the previous window is absent or destroyed: %s',
    (window) => {
      mocks.state.mainWindow = window

      expect(() => openMainWindow()).toThrow('startup services not ready')
      expect(mocks.requireServices).toHaveBeenCalledOnce()
      expect(mocks.createWindow).not.toHaveBeenCalled()
    }
  )
})
