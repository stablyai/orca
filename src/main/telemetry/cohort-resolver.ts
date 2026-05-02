import type { Store } from '../persistence'

// Post-`Store.load()` hook that runs the existing-user first-launch banner
// state machine in main. It deliberately does NOT live inside `Store.load()`:
// Case B's write to `firstBannerSecondAskShown` must flow through
// `store.updateSettings()` so the debounced save picks it up and `flush()`
// on `will-quit` catches it if the debounce has not fired. In-place mutation
// of `parsed` inside `load()` would not trigger `scheduleSave()`, so a
// force-quit between migration and the next settings change would lose the
// flag and re-show the second-ask banner forever.
//
// Runs after `Store.load()` in `src/main/index.ts`. No-op on any cohort /
// state that does not require action — cheap to call unconditionally.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export function initCohortResolver(store: Store): void {
  const settings = store.getSettings()
  const t = settings.telemetry
  // Only the existing-user cohort with an unresolved `optedIn` drives this
  // state machine. New users (`existedBeforeTelemetryRelease === false`) have
  // `optedIn === true` by migration; any other value there is noise we
  // ignore here. Resolved existing users (optedIn true/false) are terminal.
  if (!t?.existedBeforeTelemetryRelease || t.optedIn !== null) {
    return
  }

  // Case A — the second-ask banner was rendered in a prior session and the
  // user dismissed it by any means other than Sure/No-thanks (window close,
  // crash, force-quit). Per the plan doc, that's treated as "No thanks" so
  // we never nag a third time. Terminal.
  if (t.firstBannerSecondAskShown === true) {
    store.updateSettings({ telemetry: { ...t, optedIn: false } })
    return
  }

  // Case B — the user ✕-dismissed the initial banner more than 7 days ago
  // and the second-ask has not yet been marked shown. This boot is the one
  // where the second-ask banner will render; record the decision here in
  // main so the renderer does not write during render. Next launch's Case A
  // promotes to opt-out if the user never clicked a button.
  //
  // `updateSettings` schedules the debounced write; `flush()` on `will-quit`
  // catches it if the debounce has not fired. Force-quit between this write
  // and the debounce loses at most one launch of re-ask, which is the
  // acceptable tradeoff vs. a sync-write that blocks startup.
  if (t.firstBannerDismissedAt) {
    const dismissedAt = new Date(t.firstBannerDismissedAt).getTime()
    if (!Number.isFinite(dismissedAt)) {
      // Why: a malformed timestamp (corruption, hand-edit, partial write)
      // would otherwise park the state machine here forever — `NaN >= N` is
      // always false, so Case B never advances and Case A never fires.
      // Clearing it surfaces the banner on next launch rather than silently
      // suppressing telemetry indefinitely.
      store.updateSettings({ telemetry: { ...t, firstBannerDismissedAt: undefined } })
      return
    }
    if (Date.now() - dismissedAt >= SEVEN_DAYS_MS) {
      store.updateSettings({ telemetry: { ...t, firstBannerSecondAskShown: true } })
    }
  }
}
