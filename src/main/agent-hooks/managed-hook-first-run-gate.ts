import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'

type FirstRunGateSettings = Pick<GlobalSettings, 'managedAgentHookFirstRunGate'> | null | undefined

/**
 * A fresh profile must not write user-global agent configs until the user has either passed
 * onboarding step 1 **or** left onboarding. Leaving counts deliberately: an accidental Esc must
 * not leave agent status permanently broken, and by then the user has seen step 1 with the box in
 * whatever state they left it. Kept apart from `resolveStartupManagedHookAction`: that answers
 * "what does this profile's off switch say", a different axis from first-run progress.
 */
export function isManagedHookInstallDeferredForFirstRun(input: {
  onboarding: Pick<OnboardingState, 'closedAt' | 'lastCompletedStep'>
  settings: FirstRunGateSettings
}): boolean {
  const hasPassedStepOneOrLeft =
    input.onboarding.closedAt !== null || input.onboarding.lastCompletedStep >= 1
  return input.settings?.managedAgentHookFirstRunGate === 'pending' && !hasPassedStepOneOrLeft
}

/** The latch is armed, i.e. this profile has never taken a non-deferring launch. */
export function isManagedHookFirstRunGatePending(settings: FirstRunGateSettings): boolean {
  return settings?.managedAgentHookFirstRunGate === 'pending'
}
