import { beforeEach, describe, expect, it, vi } from 'vitest'

type MainWindowStub = {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  webContents?: {
    isLoading?: () => boolean
    once?: (event: string, handler: () => void) => void
  }
}

const mocks = vi.hoisted(() => {
  const state: { mainWindow: MainWindowStub | null } = { mainWindow: null }
  return {
    state,
    requireServices: vi.fn(),
    createWindow: vi.fn(),
    logStartup: vi.fn(),
    safelyRevealWindow: vi.fn()
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
vi.mock('../window/focus-existing-window', () => ({
  safelyRevealWindow: mocks.safelyRevealWindow
}))

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
    const window = {
      isDestroyed: () => false,
      isVisible: () => true
    }
    mocks.state.mainWindow = window

    expect(openMainWindow({ revealOnDidFinishLoad: true })).toBe(window)
    expect(openMainWindow()).toBe(window)
    expect(mocks.safelyRevealWindow).not.toHaveBeenCalled()
    expect(mocks.requireServices).not.toHaveBeenCalled()
    expect(mocks.createWindow).not.toHaveBeenCalled()
    expect(mocks.logStartup).not.toHaveBeenCalled()
  })

  it('reveals a hidden loaded window when reused with revealOnDidFinishLoad', () => {
    const window = {
      isDestroyed: () => false,
      isVisible: () => false,
      webContents: {
        isLoading: () => false,
        once: vi.fn()
      }
    }
    mocks.state.mainWindow = window

    expect(openMainWindow({ revealOnDidFinishLoad: true })).toBe(window)
    expect(mocks.safelyRevealWindow).toHaveBeenCalledWith(window)
    expect(window.webContents.once).not.toHaveBeenCalled()
  })

  it('schedules reveal on did-finish-load when reusing an unrevealed loading window', () => {
    let loadHandler: (() => void) | undefined
    const window = {
      isDestroyed: () => false,
      isVisible: vi.fn(() => false),
      webContents: {
        isLoading: () => true,
        once: vi.fn((event, handler) => {
          if (event === 'did-finish-load') {
            loadHandler = handler
          }
        })
      }
    }
    mocks.state.mainWindow = window

    expect(openMainWindow({ revealOnDidFinishLoad: true })).toBe(window)
    expect(mocks.safelyRevealWindow).not.toHaveBeenCalled()
    expect(window.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function))

    loadHandler?.()
    expect(mocks.safelyRevealWindow).toHaveBeenCalledWith(window)
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
