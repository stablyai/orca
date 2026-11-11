import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { mobileSnapshotInventoryOnlyChanged } from './mobile-session-snapshot-equality'

/** The snapshot as stored: its version moves past the stored one so readers always see a newer stamp. */
export function stampMobileSnapshotVersion(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  // Catalog-only metadata advances renderer admission, not the phone's visible publication.
  if (existing && mobileSnapshotInventoryOnlyChanged(existing, snapshot)) {
    return { ...snapshot, snapshotVersion: existing.snapshotVersion }
  }
  const snapshotVersion = existing
    ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
    : snapshot.snapshotVersion
  return snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
}
