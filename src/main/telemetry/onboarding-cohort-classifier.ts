// Known limitation: live completion shares upgrade-backfill shape, so dashboards forward-fill cohort from _started (onboarding-telemetry-extensions.md §2). TODO: add a migration sentinel. Failed/uninitialized reads omit the optional cohort rather than break telemetry.

import { ONBOARDING_FINAL_STEP } from '../../shared/onboarding-defaults'
import type { OnboardingCohort } from '../../shared/telemetry-events'
import type { Store } from '../persistence'

let storeRef: Store | null = null

let warnedThisSession = false

export function initOnboardingCohortClassifier(store: Store): void {
  storeRef = store
  warnedThisSession = false
}

export function getOnboardingCohortAtEmit(): { cohort: OnboardingCohort | undefined } {
  if (!storeRef) {
    warnOnce('store not initialized')
    return { cohort: undefined }
  }
  try {
    // Read settings first so onboarding failure cannot hide a proven fresh-install cohort.
    const settings = storeRef.getSettings()
    const existedBefore = settings.telemetry?.existedBeforeTelemetryRelease
    if (existedBefore === false) {
      return { cohort: 'fresh_install' }
    }
    if (existedBefore === true) {
      // Backfill and live completion share this canonical shape; classification is therefore ambiguous.
      const onboarding = storeRef.getOnboarding()
      if (
        onboarding.outcome === 'completed' &&
        onboarding.lastCompletedStep === ONBOARDING_FINAL_STEP
      ) {
        return { cohort: 'upgrade_backfill' }
      }
      return { cohort: 'fresh_install' }
    }
    return { cohort: undefined }
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err))
    return { cohort: undefined }
  }
}

function warnOnce(reason: string): void {
  if (warnedThisSession) {
    return
  }
  warnedThisSession = true
  console.warn('[telemetry-onboarding-cohort] classifier returned undefined', { reason })
}

export function _setStoreForTests(store: Store | null): void {
  storeRef = store
}

export function _resetSessionWarnFlagForTests(): void {
  warnedThisSession = false
}
