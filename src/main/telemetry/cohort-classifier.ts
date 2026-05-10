// Single source of truth for cohort state attached to telemetry events.
// See docs/onboarding-funnel-cohort-addendum.md.
//
// `nth_repo_added` is the count of repos the user has at the moment the
// event fires — read from `store.getRepoCount()`. The rule is single
// and consistent: the value reflects current store state at emit time.
// On `repo_added` the read happens *after* `store.addRepo` lands, so the
// user's Nth repo addition emits `N` (the just-landed write is included).
// On every other event, the same read returns whatever the count is —
// including `0` for a brand-new user on `app_opened` who has never added
// a repo. That `0` is the canonical session-zero / pre-repo cohort signal,
// not a sentinel and not "undefined."
//
// Failure mode: this module never throws. On any read error or
// store-not-yet-initialized condition, `getCohortAtEmit` returns
// `{ nth_repo_added: undefined }`. The schemas declare the field
// `.optional()`, so an event with an undefined cohort still validates and
// emits — it just lands without the cohort property. This preserves the
// telemetry rule "must never crash the app."

import type { Store } from '../persistence'

let storeRef: Store | null = null

// Session-scoped flag analogous to `appOpenedTrackedThisSession` in
// `client.ts`: emit one debug breadcrumb per session if the classifier
// has to fail soft, so missing cohort data has a corresponding log line
// without flooding stderr.
let warnedThisSession = false

export function initCohortClassifier(store: Store): void {
  storeRef = store
  warnedThisSession = false
}

export function getCohortAtEmit(): { nth_repo_added: number | undefined } {
  if (!storeRef) {
    warnOnce('store not initialized')
    return { nth_repo_added: undefined }
  }
  try {
    const length = storeRef.getRepoCount()
    return { nth_repo_added: length }
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err))
    return { nth_repo_added: undefined }
  }
}

function warnOnce(reason: string): void {
  if (warnedThisSession) {
    return
  }
  warnedThisSession = true
  console.warn('[telemetry-cohort] classifier returned undefined', { reason })
}

export function _setStoreForTests(store: Store | null): void {
  storeRef = store
}

export function _resetSessionWarnFlagForTests(): void {
  warnedThisSession = false
}
