import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'

// Anonymous UUID v4 that keys the user as a telemetry subject. Two contracts
// this module must preserve:
//
// 1. Stability across launches. The migration in `persistence.ts` populates
//    `GlobalSettings.telemetry.installId` once; `readInstallId` is the sole
//    read path so call sites cannot accidentally regenerate it by reaching
//    into the store themselves.
//
// 2. Rotability from the Privacy pane. `resetInstallId` generates a fresh
//    UUID and persists it via `store.updateSettings` so the normal debounced
//    save picks it up. PR 3 wires the Privacy pane button to this; PR 2
//    wires the PostHog reset(). In PR 1 the reset path exists but has no
//    caller — keeping it here (vs. client.ts) keeps pure install-id logic in
//    one file and leaves `client.ts` a thin vendor wrapper.

export function generateInstallId(): string {
  return randomUUID()
}

// Lookup-only. Returns undefined if `telemetry` is missing — this only
// happens before `Store.load()` has run the migration, which is an invariant
// violation everywhere else. Callers can treat undefined as "telemetry not
// initialized yet" rather than silently regenerating here (regenerating
// behind a caller's back would mask a startup-ordering bug).
export function readInstallId(store: Store): string | undefined {
  return store.getSettings().telemetry?.installId
}

// Rotation path used by the Privacy pane's "Reset anonymous ID" button. Why
// `updateSettings` instead of a bespoke setter: `updateSettings` already
// performs the deep-merge that keeps `notifications` intact, schedules the
// 300 ms debounced save, and is the one sanctioned way to mutate persisted
// settings. Duplicating the merge path risks dropping sibling fields on a
// future schema addition.
export function resetInstallId(store: Store): string {
  const settings = store.getSettings()
  const telemetry = settings.telemetry
  // Defensive: migration should have populated this by the time the Privacy
  // pane can call reset. If it somehow hasn't, initialize rather than throw
  // — the user clicked a button; failing silently loudly is worse than
  // returning a fresh ID.
  const newId = generateInstallId()
  store.updateSettings({
    telemetry: telemetry
      ? { ...telemetry, installId: newId }
      : {
          optedIn: null,
          installId: newId,
          existedBeforeTelemetryRelease: true
        }
  })
  return newId
}
