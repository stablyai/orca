import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fixture = vi.hoisted(() => {
  const settings: Partial<GlobalSettings> = { agentStatusHooksEnabled: true }
  return {
    app: { isPackaged: true, on: vi.fn() },
    settings,
    pathReady: Promise.resolve(),
    startCodexHooks: vi.fn(),
    installFirstWorkRename: vi.fn()
  }
})

vi.mock('electron', () => ({ app: fixture.app, nativeTheme: {} }))
vi.mock('../codex/codex-hook-reconcile', () => ({ startCodexHooks: fixture.startCodexHooks }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({
  hydrateAgentCliShellPath: () => fixture.pathReady
}))
// Why the real predicate: the start must read the same opt-out the rest of Orca does.
vi.mock(
  '../agent-hooks/managed-agent-hook-controls',
  async () => await import('../../shared/agent-status-hooks-setting')
)
vi.mock('./main-process-state', () => ({
  mainProcessState: { store: { getSettings: () => fixture.settings } }
}))
vi.mock('./main-process-runtime-service', () => ({
  initializeMainProcessRuntime: () => ({
    setAgentBrowserBridge: vi.fn(),
    setEmulatorBridge: vi.fn()
  }),
  configureRuntimeServices: vi.fn()
}))
vi.mock('../star-nag/service', () => ({
  StarNagService: class {
    start = vi.fn()
    registerIpcHandlers = vi.fn()
  }
}))
vi.mock('../browser/agent-browser-bridge', () => ({
  AgentBrowserBridge: class {
    sweepOrphanedSessions = vi.fn()
  }
}))
vi.mock('../emulator/emulator-bridge', () => ({ EmulatorBridge: class {} }))
vi.mock('../runtime/rpc/dispatcher', () => ({ RpcDispatcher: class {} }))
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../browser/browser-client-page-automation-runtime', () => ({
  configureBrowserClientPageAutomationRuntime: vi.fn()
}))
vi.mock('../crash-reporting/process-gone-diagnostics', () => ({
  startPreGoneCrashSampling: vi.fn()
}))
vi.mock('./main-window-lifecycle-flags', () => ({ recordProcessGoneCrash: vi.fn() }))
vi.mock('./gpu-lifecycle', () => ({ handleGpuChildCrash: vi.fn() }))
vi.mock('./configure-process', () => ({ shouldInstallManagedHooks: () => false }))
vi.mock('../agent-hooks/install-telemetry', () => ({ recordManagedHookInstallFailure: vi.fn() }))
vi.mock('./main-process-observers', () => ({ initializeMainProcessObservers: vi.fn() }))
vi.mock('./branch-rename-hook', () => ({
  installFirstWorkRenameHookSubscription: fixture.installFirstWorkRename
}))
vi.mock('./main-process-account-services', () => ({
  initializeMainProcessAccountServices: vi.fn()
}))
vi.mock('./main-process-automations', () => ({ initializeMainProcessAutomations: vi.fn() }))
vi.mock('./main-process-plugins', () => ({ initializeMainProcessPlugins: vi.fn() }))
vi.mock('../worktree-trash', () => ({
  collectWorktreeTrashSweepRoots: vi.fn(),
  sweepStaleWorktreeTrash: vi.fn()
}))
vi.mock('./worktree-removal-records-load', () => ({ loadWorktreeRemovalRecordsForStore: vi.fn() }))
vi.mock('./first-window-deferral', () => ({ runAfterFirstWindowShown: vi.fn() }))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../opencode/opencode-status-plugin-startup-refresh', () => ({
  refreshInstalledOpenCodeStatusPlugins: vi.fn()
}))
vi.mock('../orcad/orcad-artifact-cache-retention', () => ({
  pruneDesktopOrcadArtifactCache: vi.fn()
}))

import { initializeReadyRuntimeServices } from './main-process-ready-runtime'

// Why this file: without the start, no managed launch may ask Codex for its hook hash
// and ~/.codex is never reconciled; without the PATH wait, a packaged app looks
// for codex on launchd's PATH and finds none.

beforeEach(() => {
  fixture.startCodexHooks.mockClear()
  fixture.settings.disabledTuiAgents = []
})

describe('Codex hook startup', () => {
  it('starts once in app readiness, after the shell PATH is hydrated', async () => {
    let hydrate: () => void = () => {}
    fixture.pathReady = new Promise<void>((resolve) => {
      hydrate = resolve
    })

    await initializeReadyRuntimeServices()

    expect(fixture.startCodexHooks).toHaveBeenCalledTimes(1)
    let ready = false
    const { pathReady } = fixture.startCodexHooks.mock.calls[0]![0]
    void pathReady.then(() => {
      ready = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ready).toBe(false)
    hydrate()
    await pathReady
    expect(ready).toBe(true)
  })

  it("reads Codex's per-agent hook setting each time it is asked", async () => {
    await initializeReadyRuntimeServices()
    const { isEnabled } = fixture.startCodexHooks.mock.calls[0]![0]

    expect(isEnabled()).toBe(true)
    fixture.settings.disabledTuiAgents = ['codex']
    expect(isEnabled()).toBe(false)
  })
})

// Why here: headless serve runs app readiness but never opens a window, so first-work rename
// must be armed by readiness itself, not by the window's hook listener (STA-5871).
describe('First-work rename startup', () => {
  it('arms the hook subscription during app readiness, without a window', async () => {
    fixture.installFirstWorkRename.mockClear()

    await initializeReadyRuntimeServices()

    expect(fixture.installFirstWorkRename).toHaveBeenCalledTimes(1)
  })
})
