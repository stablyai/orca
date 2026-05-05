import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'

// Anonymous UUID v4 that keys the user as a telemetry subject. Stability
// across launches is the single contract this module preserves: the
// migration in `persistence.ts` populates `GlobalSettings.telemetry.installId`
// once, and `readInstallId` is the sole read path so call sites cannot
// accidentally regenerate it by reaching into the store themselves.

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
