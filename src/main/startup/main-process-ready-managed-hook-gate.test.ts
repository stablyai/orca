import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type * as AgentStatusHooksEnablement from '../agent-hooks/agent-status-hooks-enablement'

/**
 * The behavioural half of the managed-hook first-run gate. `startup-managed-hook-plan.test.ts`
 * tables the decision; this drives the real ready phase so that dropping the plan call, the
 * `shouldReconcile` conjunct or the latch-retirement write turns red. Without it the whole startup
 * gate can be reverted to origin/main with every other suite still green.
 */
const {
  installManagedAgentHooksMock,
  ensureRealHomeCodexHookStateMock,
  mainProcessStateFake,
  runtimeFake
} = vi.hoisted(() => ({
  installManagedAgentHooksMock: vi.fn(async () => []),
  ensureRealHomeCodexHookStateMock: vi.fn(async () => undefined),
  runtimeFake: {
    setAgentBrowserBridge: vi.fn(),
    setEmulatorBridge: vi.fn(),
    notifyMobileSessionTabsChanged: vi.fn()
  },
  mainProcessStateFake: {
    store: null as unknown,
    stats: {},
    isQuitting: false,
    isServeMode: false,
    codexRuntimeHome: null as { isHostSystemDefaultRealHomeSelected: () => boolean } | null,
    agentBrowserBridge: null as unknown,
    emulatorBridge: null as unknown,
    gpuCrashDiagnostics: null
  }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/orca-managed-hook-gate-test'),
    on: vi.fn()
  },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../star-nag/service', () => ({
  StarNagService: class {
    start = vi.fn()
    registerIpcHandlers = vi.fn()
  }
}))
vi.mock('../browser/agent-browser-bridge', () => ({
  AgentBrowserBridge: class {
    sweepOrphanedSessions = vi.fn(async () => undefined)
  }
}))
vi.mock('../emulator/emulator-bridge', () => ({ EmulatorBridge: class {} }))
vi.mock('../runtime/rpc/dispatcher', () => ({
  RpcDispatcher: class {
    dispatch = vi.fn()
  }
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../browser/browser-client-page-automation-runtime', () => ({
  configureBrowserClientPageAutomationRuntime: vi.fn()
}))
vi.mock('../browser/browser-client-page-command-failure', () => ({
  BrowserClientPageCommandError: class extends Error {}
}))
vi.mock('../crash-reporting/process-gone-diagnostics', () => ({
  startPreGoneCrashSampling: vi.fn()
}))
vi.mock('./main-window-lifecycle-flags', () => ({ recordProcessGoneCrash: vi.fn() }))
vi.mock('./gpu-lifecycle', () => ({ handleGpuChildCrash: vi.fn() }))
vi.mock('../crash-reporting/gpu-crash-fallback-decision', () => ({
  isGpuFallbackCrashCandidate: vi.fn(() => false)
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: ensureRealHomeCodexHookStateMock
}))
// Only the installer is faked: the real module's registry drags in every per-agent hook service,
// but the off-switch predicates live in a registry-free module, so those stay real.
vi.mock('../agent-hooks/managed-agent-hook-controls', async () => {
  const enablement = await vi.importActual<typeof AgentStatusHooksEnablement>(
    '../agent-hooks/agent-status-hooks-enablement'
  )
  return {
    installManagedAgentHooks: installManagedAgentHooksMock,
    resolveStartupManagedHookAction: enablement.resolveStartupManagedHookAction,
    shouldContinueManagedHookStartup: enablement.shouldContinueManagedHookStartup,
    shouldInstallStartupManagedAgentHook: enablement.shouldInstallStartupManagedAgentHook
  }
})
vi.mock('./configure-process', () => ({ shouldInstallManagedHooks: vi.fn(() => true) }))
vi.mock('../agent-hooks/install-telemetry', () => ({
  recordManagedHookInstallFailure: vi.fn()
}))
vi.mock('./main-process-state', () => ({ mainProcessState: mainProcessStateFake }))
vi.mock('./main-process-observers', () => ({ initializeMainProcessObservers: vi.fn() }))
vi.mock('./main-process-account-services', () => ({
  initializeMainProcessAccountServices: vi.fn()
}))
vi.mock('./main-process-runtime-service', () => ({
  initializeMainProcessRuntime: vi.fn(() => runtimeFake),
  configureRuntimeServices: vi.fn()
}))
vi.mock('./main-process-automations', () => ({ initializeMainProcessAutomations: vi.fn() }))
vi.mock('./main-process-plugins', () => ({
  initializeMainProcessPlugins: vi.fn(async () => undefined)
}))
vi.mock('../worktree-trash', () => ({
  collectWorktreeTrashSweepRoots: vi.fn(() => []),
  sweepStaleWorktreeTrash: vi.fn(async () => undefined)
}))
vi.mock('./first-window-deferral', () => ({ runAfterFirstWindowShown: vi.fn() }))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))

import { initializeReadyRuntimeServices } from './main-process-ready-runtime'

function createStoreFake(initial: {
  onboarding?: Partial<OnboardingState>
  settings?: Partial<GlobalSettings>
}) {
  let settings = {
    disabledTuiAgents: [],
    managedAgentHookFirstRunGate: 'pending',
    ...initial.settings
  } as GlobalSettings
  const onboarding = {
    flowVersion: 1,
    closedAt: null,
    outcome: null,
    lastCompletedStep: -1,
    ...initial.onboarding
  } as OnboardingState
  return {
    getSettings: vi.fn(() => settings),
    getOnboarding: vi.fn(() => onboarding),
    getRepos: vi.fn(() => []),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function latchWrites(store: ReturnType<typeof createStoreFake>): Partial<GlobalSettings>[] {
  return store.updateSettings.mock.calls
    .map(([updates]) => updates)
    .filter((updates) => 'managedAgentHookFirstRunGate' in updates)
}

async function runReadyPhase(store: ReturnType<typeof createStoreFake>): Promise<void> {
  mainProcessStateFake.store = store
  await initializeReadyRuntimeServices()
  // The reconcile hangs off the codex real-home chain, so drain its microtasks before asserting.
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve()
  }
}

describe('managed hook first-run gate in the ready phase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mainProcessStateFake.isServeMode = false
    mainProcessStateFake.isQuitting = false
    mainProcessStateFake.codexRuntimeHome = null
  })

  it('writes nothing user-global for a fresh profile that has not reached step 1', async () => {
    const store = createStoreFake({})

    await runReadyPhase(store)

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(ensureRealHomeCodexHookStateMock).not.toHaveBeenCalled()
    // The latch must stay armed, or the next launch installs without ever having asked.
    expect(latchWrites(store)).toEqual([])
  })

  it('reconciles once and retires the latch after the user passes step 1', async () => {
    const store = createStoreFake({ onboarding: { lastCompletedStep: 1 } })

    await runReadyPhase(store)

    expect(latchWrites(store)).toEqual([{ managedAgentHookFirstRunGate: 'done' }])
    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('never defers on a serve host, which never paints the wizard', async () => {
    mainProcessStateFake.isServeMode = true
    const store = createStoreFake({})

    await runReadyPhase(store)

    expect(latchWrites(store)).toEqual([{ managedAgentHookFirstRunGate: 'done' }])
    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('still honours the off switch on a profile whose latch has already retired', async () => {
    const store = createStoreFake({
      onboarding: { lastCompletedStep: 1 },
      settings: { managedAgentHookFirstRunGate: 'done', agentStatusHooksEnabled: false }
    })

    await runReadyPhase(store)

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(latchWrites(store)).toEqual([])
  })
})
