// Cohort discriminator for onboarding-wizard telemetry events. See
// docs/onboarding-telemetry-extensions.md §2.
//
// `'fresh_install'` ⇔ `existedBeforeTelemetryRelease === false`. New users
// land on the wizard on first launch; the cohort never moves.
//
// `'upgrade_backfill'` ⇔ `existedBeforeTelemetryRelease === true` AND the
// onboarding state was backfilled at load time as a completed wizard run
// (the persistence migration at `src/main/persistence.ts:362-369` writes
// `outcome: 'completed'` and `lastCompletedStep: ONBOARDING_FINAL_STEP` for
// existing users that lack an onboarding block). A pre-existing user who is
// dropped into the wizard via the upgrade-backfill surface emits this
// cohort on every wizard event.
//
// Known limitation: the discriminator infers the migration-backfilled state
// from its canonical shape (`outcome === 'completed'` AND
// `lastCompletedStep === ONBOARDING_FINAL_STEP`). That shape is *also* what
// a live wizard completion writes via `closeWith('completed', ...)`. As a
// result, a real existing-user (`existedBeforeTelemetryRelease === true`)
// who goes through the wizard live will be classified as `fresh_install`
// during the wizard, then *flip* to `upgrade_backfill` on the very next
// event after `closeWith` persists the completion. Dashboard-side
// workaround: filter `cohort` on the `_started` event and forward-fill
// across the session, rather than re-reading the cohort on terminal
// events. Structural follow-up (out of scope here): add a sentinel
// `wasBackfilledByMigration: true` field at migration time so the
// classifier can disambiguate without dashboard-side gymnastics.
//
// Failure mode: this module never throws. On any read error or
// store-not-yet-initialized condition, `getOnboardingCohortAtEmit` returns
// `{ cohort: undefined }`. The schemas declare the field `.optional()`, so
// an event with an undefined cohort still validates and emits — it just
// lands without the cohort property. Mirrors `getCohortAtEmit`.

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
    // Why: fresh_install classification depends only on the settings flag,
    // so we read settings first and skip getOnboarding() entirely on that
    // branch — a failing onboarding read must not demote a fresh-install
    // user to `{ cohort: undefined }`.
    const settings = storeRef.getSettings()
    const existedBefore = settings.telemetry?.existedBeforeTelemetryRelease
    if (existedBefore === false) {
      return { cohort: 'fresh_install' }
    }
    if (existedBefore === true) {
      // Why: an existing-user cohort marker can coexist with a fresh
      // wizard run (the migration only backfills when there's no
      // onboarding block on disk). The `upgrade_backfill` cohort is
      // specifically the user who was force-completed by the migration —
      // detected by the canonical `outcome === 'completed'` AND
      // `lastCompletedStep === ONBOARDING_FINAL_STEP` shape that
      // persistence.ts:362-369 writes. Caveat: the same canonical shape is
      // produced by `closeWith('completed', ...)` after a live wizard run,
      // so an existing user who completes the wizard live will be
      // classified as `fresh_install` during the wizard and then flip to
      // `upgrade_backfill` on the next event after completion is
      // persisted. See the top-of-file "Known limitation" block for the
      // dashboard-side workaround and the proposed sentinel-field fix.
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
