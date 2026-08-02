// Cohort discriminator for onboarding-wizard telemetry. See docs/onboarding-telemetry-extensions.md §2.
// Known limitation: upgrade_backfill's "completed" shape (persistence.ts:362-369) is also written by live completion, so an existing live-completer flips fresh_install→upgrade_backfill; dashboards forward-fill cohort from _started. TODO: a wasBackfilledByMigration sentinel would disambiguate.
// Never throws: returns { cohort: undefined } on any read/uninit error, which the schema's .optional() cohort still validates. Mirrors sibling getCohortAtEmit's never-crash contract.

import { ONBOARDING_FINAL_STEP } from '../../shared/constants'
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
    // Why: read settings first so a failing getOnboarding() can't demote a fresh_install user to undefined.
    const settings = storeRef.getSettings()
    const existedBefore = settings.telemetry?.existedBeforeTelemetryRelease
    if (existedBefore === false) {
      return { cohort: 'fresh_install' }
    }
    if (existedBefore === true) {
      // Why: this canonical completed shape is written by both migration backfill and live completion, so it's ambiguous (see top-of-file "Known limitation").
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
