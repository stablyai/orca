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

/** The stored frame is built on the window publication last accepted for it (merged host rows
 *  included), so it holds that window's complete content for the workspace. */
export function storedFrameFollowsRendererPublication(
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  accepted: { publicationEpoch: string } | undefined
): boolean {
  return (
    !!existing &&
    !!accepted &&
    (existing.publicationEpoch === accepted.publicationEpoch ||
      existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`))
  )
}
