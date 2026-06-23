// Pure helpers for reconciling incoming session-tab snapshots on mobile. Kept
// free of react-native imports so they stay unit-testable in the node test env.
// Two races motivate these: out-of-order snapshots (subscription vs poll vs
// post-mutation refetch) and the brief window after a local close before the
// publisher's snapshot reflects it.

/** The last snapshot applied from a publisher, used to reject older ones. */
export type AppliedSnapshotMarker = { epoch: string | null; version: number }

/**
 * Whether an incoming snapshot should be applied. Rejects only snapshots
 * STRICTLY older than the last applied one from the same publisher (epoch) so an
 * out-of-order response can't revive a tab a newer snapshot dropped. Equal
 * versions are accepted (and reprocessed) — polling returns the same cached
 * version repeatedly, and reprocessing is what lets close tombstones expire and
 * clear; rejecting equal versions would strand them. A different epoch is a new
 * publisher (renderer reload / headless), accepted as the new floor. Mutates
 * `marker` to record the accepted snapshot.
 */
export function acceptSessionSnapshot(
  incoming: { publicationEpoch?: string; snapshotVersion: number },
  marker: AppliedSnapshotMarker
): boolean {
  const incomingEpoch = incoming.publicationEpoch ?? null
  if (incomingEpoch === marker.epoch) {
    if (incoming.snapshotVersion < marker.version) {
      return false
    }
  } else {
    marker.epoch = incomingEpoch
  }
  marker.version = incoming.snapshotVersion
  return true
}

/**
 * Drops tabs the user just closed locally (tombstoned) until the publisher's
 * snapshot also drops them or the tombstone expires. Mutates `tombstones`,
 * clearing entries the publisher has confirmed gone (absent from `tabs`) or
 * whose TTL elapsed — the TTL guards against a failed host-side close hiding a
 * tab forever.
 */
export function applyClosedTabTombstones<T extends { id: string }>(
  tabs: T[],
  tombstones: Map<string, number>,
  now: number
): T[] {
  if (tombstones.size === 0) {
    return tabs
  }
  const suppressed = new Set<string>()
  const next = tabs.filter((tab) => {
    const expiry = tombstones.get(tab.id)
    if (expiry === undefined) {
      return true
    }
    if (now >= expiry) {
      tombstones.delete(tab.id)
      return true
    }
    suppressed.add(tab.id)
    return false
  })
  for (const [id, expiry] of tombstones) {
    if (!suppressed.has(id) || now >= expiry) {
      tombstones.delete(id)
    }
  }
  return next
}
