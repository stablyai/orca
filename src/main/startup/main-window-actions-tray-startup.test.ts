import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { quit: vi.fn() } }))
vi.mock('../updater', () => ({ checkForUpdatesFromMenu: vi.fn(), isQuittingForUpdate: vi.fn() }))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
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

import { createSystemTrayDeferred } from './main-window-actions'
import { mainProcessState as state } from './main-process-state'
import { createSystemTray } from '../tray/system-tray'

const originalPlatform = process.platform
const isDestroyed = vi.fn(() => false)
const onCreated = vi.fn()

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup tray creation only reads isDestroyed from the window.
const window = { isDestroyed } as unknown as Electron.BrowserWindow
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup callback only checks whether a tray was returned.
const tray = {} as Electron.Tray

function startupTrayCallback(): () => void {
  const createTray = createSystemTrayDeferred(window, onCreated)
  if (!createTray) {
    throw new Error('expected a startup tray callback off macOS')
  }
  return createTray
}

describe('Windows startup tray callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    isDestroyed.mockReturnValue(false)
    Object.assign(state, {
      isQuitting: false,
      isServeMode: false,
      store: { getSettings: () => ({ appIcon: 'default' }) },
      devInstanceIdentity: null
    })
    vi.mocked(createSystemTray).mockReturnValue(null)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    state.store = null
    state.isQuitting = false
  })

  it('has no startup callback on macOS, whose status item waits for its gate', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(createSystemTrayDeferred(window, onCreated)).toBeNull()
  })

  it('creates synchronously and only once when first paint and the fallback both fire', () => {
    vi.mocked(createSystemTray).mockReturnValue(tray)
    const createTray = startupTrayCallback()
    createTray()
    createTray()

    expect(createSystemTray).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it.each(['closed', 'quitting', 'store-unavailable'] as const)(
    'does not create a tray once startup is %s',
    (reason) => {
      if (reason === 'closed') {
        isDestroyed.mockReturnValue(true)
      }
      if (reason === 'quitting') {
        state.isQuitting = true
      }
      if (reason === 'store-unavailable') {
        state.store = null
      }
      startupTrayCallback()()

      expect(createSystemTray).not.toHaveBeenCalled()
      expect(onCreated).not.toHaveBeenCalled()
    }
  )

  it('allows a later attempt if the store was unavailable at first paint', () => {
    const store = state.store
    const createTray = startupTrayCallback()
    state.store = null
    createTray()
    state.store = store
    createTray()

    expect(createSystemTray).toHaveBeenCalledOnce()
  })
})
