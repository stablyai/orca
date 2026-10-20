import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createMainWindow: vi.fn(),
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn(),
  isQuittingForUpdate: vi.fn(() => false),
  logStartupMilestone: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '0.0.0', name: 'Orca', quit: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn() }
}))
vi.mock('../window/createMainWindow', () => ({
  createMainWindow: mocks.createMainWindow,
  loadMainWindow: vi.fn()
}))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: mocks.createSystemTray,
  setMacMenuBarIconVisible: mocks.setMacMenuBarIconVisible,
  setTrayAttention: vi.fn()
}))
vi.mock('../updater', () => ({
  checkForUpdatesFromMenu: vi.fn(),
  isQuittingForUpdate: mocks.isQuittingForUpdate
}))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: mocks.logStartupMilestone }))
vi.mock('./main-window-service-readiness', () => ({
  requireMainWindowServices: () => ({ store: {}, keybindings: { getOverrides: () => undefined } })
}))
vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: vi.fn(),
  recordCoalescedCrashBreadcrumb: vi.fn()
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('../crash-reporting/process-gone-classification', () => ({
  shouldRecoverRendererAfterProcessGone: vi.fn()
}))
vi.mock('../telemetry/consent', () => ({ resolveConsent: () => ({ effective: 'disabled' }) }))
vi.mock('../telemetry/client', () => ({ trackAppOpenedOnce: vi.fn() }))
vi.mock('./windows-user-data-acl', () => ({ ensureWindowsUserDataAclGrant: vi.fn() }))
vi.mock('./windows-install-dir-acl-probe', () => ({ probeWindowsInstallDirAcl: () => false }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  describeInstallDirAclPoison: vi.fn(),
  isBlockingInstallDirAclRepairInFlight: vi.fn(),
  noteWindowsInstallDirAclProbePending: vi.fn(),
  startWindowsInstallDirAclRepairIfPoisoned: vi.fn()
}))
vi.mock('../window/main-window-visibility', () => ({ notifyMainWindowBecameVisible: vi.fn() }))
vi.mock('./main-window-core-services', () => ({ attachMainWindowCoreServices: vi.fn() }))
vi.mock('./main-window-agent-status', () => ({
  clearMainWindowAgentStatusListeners: vi.fn(),
  installMainWindowAgentStatusListeners: vi.fn()
}))
vi.mock('./main-window-lifecycle-flags', () => ({
  clearExpectedRendererReload: vi.fn(),
  getExpectedTeardownScope: vi.fn(),
  markExpectedRendererReload: vi.fn(),
  markRecoveryReloadInFlight: vi.fn(),
  recordProcessGoneCrash: vi.fn()
}))
vi.mock('./gpu-lifecycle', () => ({ presentGpuFallbackRecoveredLaunchPrompt: vi.fn() }))
vi.mock('./branch-rename-hook', () => ({ maybeAutoRenameBranchOnFirstWorkFromHook: vi.fn() }))
vi.mock('./synthetic-title-runtime', () => ({
  resumeSyntheticTitleSpinnerTimer: vi.fn(),
  stopSyntheticTitleSpinnerTimer: vi.fn()
}))
vi.mock('../window/renderer-launch-failure-probe', () => ({
  probeRendererLaunchCapacity: vi.fn(),
  recordRendererLaunchFailureProbe: vi.fn()
}))
vi.mock('../window/attach-main-window-services', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: vi.fn(),
  safelyRevealWindow: vi.fn()
}))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))

const GRACE_MS = 10_000
const OLD_FALLBACK_MS = 12_000
const originalPlatform = process.platform
const settings = { showMenuBarIcon: true, appIcon: 'default' }

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { id: 1, send: vi.fn() })
  destroyed = false
  isDestroyed = (): boolean => this.destroyed

  loadDocument(): void {
    this.webContents.emit('did-navigate')
    this.webContents.emit('did-finish-load')
  }

  loadErrorDocument(): void {
    this.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true)
    this.webContents.emit('did-finish-load')
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

type Harness = Awaited<ReturnType<typeof loadController>>

async function loadController() {
  // Why: the gate is process-wide, so every case starts from a fresh process.
  vi.resetModules()
  const { openMainWindow } = await import('./main-window-controller')
  const actions = await import('./main-window-actions')
  const { mainProcessState: state } = await import('./main-process-state')
  Object.assign(state, {
    store: { getSettings: () => settings },
    isQuitting: false,
    isServeMode: false,
    devInstanceIdentity: null
  })
  const open = (): FakeWindow => {
    const window = new FakeWindow()
    mocks.createMainWindow.mockReturnValueOnce(window)
    openMainWindow()
    return window
  }
  const quitAbortedFor = (): (() => void) => {
    const opts = mocks.createMainWindow.mock.calls.at(-1)?.[1]
    return () => opts?.onQuitAborted?.()
  }
  return { actions, state, open, quitAbortedFor }
}

// Why: a 0ms timer scheduled inside a fake tick lands 1ms later, so step past the AppKit turn too.
function advancePastGrace(ms = GRACE_MS): void {
  vi.advanceTimersByTime(ms + 1)
}

function macIconCalls(): boolean[] {
  return mocks.setMacMenuBarIconVisible.mock.calls.map(([visible]) => visible)
}

function milestones(event: string): number {
  return mocks.logStartupMilestone.mock.calls.filter(([name]) => name === event).length
}

let harness: Harness

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  settings.showMenuBarIcon = true
  mocks.isQuittingForUpdate.mockReturnValue(false)
  mocks.createSystemTray.mockReturnValue({})
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  harness = await loadController()
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('macOS status item startup gate', () => {
  it('does not create the item at ready-to-show or the old 12s fallback', () => {
    const window = harness.open()
    window.emit('ready-to-show')
    vi.advanceTimersByTime(60_000)

    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
    expect(mocks.createSystemTray).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(milestones('ready-to-show')).toBe(1)
  })

  it('creates once, a grace after a load that lands past the old fallback', () => {
    const window = harness.open()
    window.emit('ready-to-show')
    vi.advanceTimersByTime(OLD_FALLBACK_MS + 3_000)
    window.loadDocument()
    vi.advanceTimersByTime(GRACE_MS - 1)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(milestones('tray-gate-open')).toBe(1)
    // Why: the native call must leave the timer turn that opened the gate.
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
    vi.advanceTimersToNextTimer()
    expect(mocks.setMacMenuBarIconVisible).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ onOpen: expect.any(Function), onQuit: expect.any(Function) })
    )
    vi.advanceTimersByTime(60_000)
    expect(mocks.setMacMenuBarIconVisible).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an error document and arms on the recovery load', () => {
    const window = harness.open()
    window.loadErrorDocument()
    vi.advanceTimersByTime(60_000)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
    expect(milestones('tray-gate-armed')).toBe(0)

    window.loadDocument()
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
  })

  it('ignores subframe load failures', () => {
    const window = harness.open()
    window.webContents.emit('did-navigate')
    window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', false)
    window.webContents.emit('did-finish-load')
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
  })

  it('never creates the item while the renderer never loads', () => {
    const window = harness.open()
    window.emit('ready-to-show')
    vi.advanceTimersByTime(5 * 60_000)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
  })

  it('keeps the first grace across reloads and replacement windows', () => {
    const first = harness.open()
    first.loadDocument()
    vi.advanceTimersByTime(5_000)
    first.loadDocument()
    vi.advanceTimersByTime(1_000)
    first.close()
    const second = harness.open()
    second.emit('ready-to-show')
    second.loadDocument()
    advancePastGrace(GRACE_MS - 6_000)
    expect(macIconCalls()).toEqual([true])

    const third = harness.open()
    third.loadDocument()
    vi.advanceTimersByTime(60_000)
    expect(macIconCalls()).toEqual([true])
    expect(milestones('tray-gate-armed')).toBe(1)
  })

  it('lets a later window arm the gate when the first closed before loading', () => {
    harness.open().close()
    vi.advanceTimersByTime(60_000)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()

    harness.open().loadDocument()
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
  })

  it('still creates the item when the loaded window closes during the grace', () => {
    const window = harness.open()
    window.loadDocument()
    vi.advanceTimersByTime(3_000)
    window.close()
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
  })

  it.each([
    [[false, true, false], false],
    [[false, true], true]
  ])('applies only the final preference from a pre-gate burst %j', (burst, finalVisible) => {
    harness.open().loadDocument()
    vi.advanceTimersByTime(2_000)
    for (const visible of burst) {
      settings.showMenuBarIcon = visible
      harness.actions.syncMacMenuBarIcon()
    }
    vi.advanceTimersByTime(0)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()

    advancePastGrace()
    expect(macIconCalls()).toEqual([finalVisible])
  })

  it('coalesces a post-gate burst and still applies runtime hide and re-enable', () => {
    harness.open().loadDocument()
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])

    for (const visible of [false, true, false]) {
      settings.showMenuBarIcon = visible
      harness.actions.syncMacMenuBarIcon()
    }
    expect(macIconCalls()).toEqual([true])
    vi.advanceTimersByTime(0)
    expect(macIconCalls()).toEqual([true, false])

    settings.showMenuBarIcon = true
    harness.actions.syncMacMenuBarIcon()
    vi.advanceTimersByTime(0)
    expect(macIconCalls()).toEqual([true, false, true])
  })

  it('does not create the item after a committed quit', () => {
    harness.open().loadDocument()
    vi.advanceTimersByTime(5_000)
    harness.state.isQuitting = true
    harness.actions.closeMacMenuBarIconGate()
    expect(vi.getTimerCount()).toBe(0)

    harness.actions.syncMacMenuBarIcon()
    vi.advanceTimersByTime(60_000)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
  })

  it('drops a sync queued just before the committed quit', () => {
    harness.open().loadDocument()
    advancePastGrace()
    settings.showMenuBarIcon = false
    harness.actions.syncMacMenuBarIcon()
    harness.actions.closeMacMenuBarIconGate()
    vi.advanceTimersByTime(60_000)
    expect(macIconCalls()).toEqual([true])
  })

  it('resumes after a renderer veto of a quit that spanned the grace', () => {
    harness.open().loadDocument()
    const abortQuit = harness.quitAbortedFor()
    vi.advanceTimersByTime(5_000)
    harness.state.isQuitting = true
    vi.advanceTimersByTime(GRACE_MS)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()

    abortQuit()
    expect(harness.state.isQuitting).toBe(false)
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the quit retry once a later sync applies after the veto', () => {
    harness.open().loadDocument()
    const abortQuit = harness.quitAbortedFor()
    harness.state.isQuitting = true
    advancePastGrace()
    expect(vi.getTimerCount()).toBe(1)

    abortQuit()
    settings.showMenuBarIcon = false
    harness.actions.syncMacMenuBarIcon()
    vi.advanceTimersByTime(0)
    expect(macIconCalls()).toEqual([false])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(macIconCalls()).toEqual([false])
  })

  it('resumes after an update install that failed before committing', () => {
    harness.open().loadDocument()
    mocks.isQuittingForUpdate.mockReturnValue(true)
    vi.advanceTimersByTime(GRACE_MS * 3)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()

    mocks.isQuittingForUpdate.mockReturnValue(false)
    advancePastGrace()
    expect(macIconCalls()).toEqual([true])
  })

  it('never creates the item for orca serve', () => {
    harness.state.isServeMode = true
    const window = harness.open()
    window.emit('ready-to-show')
    window.loadDocument()
    harness.actions.syncMacMenuBarIcon()
    vi.advanceTimersByTime(60_000)
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
    expect(mocks.createSystemTray).not.toHaveBeenCalled()
  })
})

describe.each(['win32', 'linux'] as const)('%s startup tray', (platform) => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('keeps the first-paint tray request and ignores the macOS gate', () => {
    const window = harness.open()
    window.emit('ready-to-show')
    vi.advanceTimersByTime(0)
    expect(mocks.createSystemTray).toHaveBeenCalledOnce()

    window.loadDocument()
    harness.actions.syncMacMenuBarIcon()
    vi.advanceTimersByTime(60_000)
    expect(mocks.createSystemTray).toHaveBeenCalledOnce()
    expect(mocks.setMacMenuBarIconVisible).not.toHaveBeenCalled()
    expect(milestones('tray-gate-armed')).toBe(0)
  })

  it('keeps the 12s fallback when first paint never arrives', () => {
    harness.open()
    vi.advanceTimersByTime(OLD_FALLBACK_MS - 1)
    expect(mocks.createSystemTray).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mocks.createSystemTray).toHaveBeenCalledOnce()
  })
})
