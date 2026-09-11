import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'

type FirstRunGateSettings = Pick<GlobalSettings, 'managedAgentHookFirstRunGate'> | null | undefined

/**
 * A fresh profile must not write user-global agent configs before the user has seen the onboarding
 * step that asks about them. Kept apart from `resolveStartupManagedHookAction`: that answers "what
 * does this profile's off switch say", which is a different axis from first-run progress.
 */
export function isManagedHookInstallDeferredForFirstRun(input: {
  onboarding: Pick<OnboardingState, 'closedAt' | 'lastCompletedStep'>
  settings: FirstRunGateSettings
}): boolean {
  return (
    input.settings?.managedAgentHookFirstRunGate === 'pending' &&
    input.onboarding.closedAt === null &&
    input.onboarding.lastCompletedStep < 1
  )
}

/** The latch is armed, i.e. this profile has never taken a non-deferring launch. */
export function isManagedHookFirstRunGatePending(settings: FirstRunGateSettings): boolean {
  return settings?.managedAgentHookFirstRunGate === 'pending'
}
