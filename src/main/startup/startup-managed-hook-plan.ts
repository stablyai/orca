import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import { resolveStartupManagedHookAction } from '../agent-hooks/agent-status-hooks-enablement'
import {
  isManagedHookFirstRunGatePending,
  isManagedHookInstallDeferredForFirstRun
} from '../agent-hooks/managed-hook-first-run-gate'

type StartupManagedHookPlanSettings = Partial<
  Pick<
    GlobalSettings,
    'agentStatusHooksEnabled' | 'disabledTuiAgents' | 'managedAgentHookFirstRunGate'
  >
> | null

export type StartupManagedHookPlan = {
  /** Nothing user-global may be written yet: a fresh profile still has step 1 ahead of it. */
  deferForFirstRun: boolean
  /** Freeze the one-shot latch, so a later wizard re-open can never re-arm the deferral. */
  shouldRetireFirstRunLatch: boolean
  /** Run the startup install/refresh pass over every enabled agent. */
  shouldReconcile: boolean
}

export function resolveStartupManagedHookPlan(input: {
  /** `shouldInstallManagedHooks(is.dev)` — whether this build reconciles hooks at all. */
  managedHooksInstallable: boolean
  isServeMode: boolean
  onboarding: Pick<OnboardingState, 'closedAt' | 'lastCompletedStep'>
  settings: StartupManagedHookPlanSettings
}): StartupManagedHookPlan {
  // Why a serve host never defers: it never paints the wizard (paired clients keep onboarding in
  // localStorage and there is no onboarding RPC), so the latch would stay armed forever.
  const deferForFirstRun =
    !input.isServeMode &&
    isManagedHookInstallDeferredForFirstRun({
      onboarding: input.onboarding,
      settings: input.settings
    })
  return {
    deferForFirstRun,
    shouldRetireFirstRunLatch:
      !deferForFirstRun && isManagedHookFirstRunGatePending(input.settings),
    shouldReconcile:
      input.managedHooksInstallable &&
      !deferForFirstRun &&
      resolveStartupManagedHookAction(input.settings) === 'install'
  }
}
