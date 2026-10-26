// Read current repo count at emit time, after repo additions land; zero identifies pre-repo sessions. Uninitialized/failed reads omit the optional cohort field so telemetry never blocks the app (onboarding-funnel-cohort-addendum.md).

import type { Store } from '../persistence'

let storeRef: Store | null = null

// Warn once per session so missing cohort data has evidence without per-event stderr noise.
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
