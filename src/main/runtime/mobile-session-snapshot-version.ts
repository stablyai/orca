import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

/** The snapshot as stored: its version moves past the stored one so readers always see a newer stamp. */
export function stampMobileSnapshotVersion(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  const snapshotVersion = existing
    ? Math.max(snapshot.snapshotVersion, existing.snapshotVersion + 1)
    : snapshot.snapshotVersion
  return snapshotVersion === snapshot.snapshotVersion ? snapshot : { ...snapshot, snapshotVersion }
}
