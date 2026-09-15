import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type * as AgentStatusHooksEnablement from '../agent-hooks/agent-status-hooks-enablement'

/**
 * The behavioural half of the managed-hook install gate. `managed-hook-install-policy.test.ts`
 * tables the decision; this drives the real ready phase so that dropping the plan call or the
 * `shouldReconcile` conjunct turns red. Without it the whole startup gate can be reverted to
 * origin/main with every other suite still green.
 */
const {
  installManagedAgentHooksMock,
  ensureRealHomeCodexHookStateMock,
  mainProcessStateFake,
  runtimeFake
} = vi.hoisted(() => ({
  installManagedAgentHooksMock: vi.fn(async (_settings?: unknown, _options?: unknown) => []),
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
import {
  getManagedHookInstallDecision,
  setManagedHookInstallDecisionResolver,
  type ManagedHookInstallationMarker
} from '../agent-hooks/managed-hook-install-policy'

const PRE_CHANGE: ManagedHookInstallationMarker = {
  installCohort: 'pre-change',
  onboardingDecision: 'passed'
}
const FRESH_PENDING: ManagedHookInstallationMarker = {
  installCohort: 'post-change',
  onboardingDecision: 'pending'
}
const FRESH_PASSED: ManagedHookInstallationMarker = {
  installCohort: 'post-change',
  onboardingDecision: 'passed'
}

function createStoreFake(initial: {
  onboarding?: Partial<OnboardingState>
  settings?: Partial<GlobalSettings>
}) {
  let settings = { disabledTuiAgents: [], ...initial.settings } as GlobalSettings
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

/** The marker the desktop bootstrap would have established for this launch. */
function establishInstallation(installation: ManagedHookInstallationMarker): void {
  setManagedHookInstallDecisionResolver((settings) =>
    getManagedHookInstallDecision({
      settings,
      installation,
      mode: mainProcessStateFake.isServeMode ? 'serve' : 'desktop'
    })
  )
}

async function runReadyPhase(store: ReturnType<typeof createStoreFake>): Promise<void> {
  mainProcessStateFake.store = store
  await initializeReadyRuntimeServices()
  // The reconcile hangs off the codex real-home chain, so drain its microtasks before asserting.
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve()
  }
}

describe('managed hook install gate in the ready phase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mainProcessStateFake.isServeMode = false
    mainProcessStateFake.isQuitting = false
    mainProcessStateFake.codexRuntimeHome = null
    setManagedHookInstallDecisionResolver(null)
  })

  afterEach(() => setManagedHookInstallDecisionResolver(null))

  it('writes nothing user-global for a fresh install that has not answered yet', async () => {
    establishInstallation(FRESH_PENDING)

    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(ensureRealHomeCodexHookStateMock).not.toHaveBeenCalled()
  })

  it('installs for an existing user upgrading, whose installation has no marker', async () => {
    establishInstallation(PRE_CHANGE)

    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('installs once the first-run question has been answered', async () => {
    establishInstallation(FRESH_PASSED)

    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('never defers on a serve host, which never paints the wizard', async () => {
    mainProcessStateFake.isServeMode = true
    establishInstallation(FRESH_PENDING)

    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('installs when no bootstrap ever established a marker', async () => {
    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock).toHaveBeenCalledTimes(1)
  })

  it('still honours the off switch on an installation that has answered', async () => {
    establishInstallation(FRESH_PASSED)

    await runReadyPhase(createStoreFake({ settings: { agentStatusHooksEnabled: false } }))

    expect(installManagedAgentHooksMock).not.toHaveBeenCalled()
  })

  it('carries the startup decision into the installer, not just the reconcile flag', async () => {
    establishInstallation(PRE_CHANGE)

    await runReadyPhase(createStoreFake({}))

    expect(installManagedAgentHooksMock.mock.calls[0]?.[1]).toMatchObject({
      installDecision: { kind: 'allow', reason: 'pre-change' }
    })
  })
})
