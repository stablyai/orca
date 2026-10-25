export type AppliedSnapshotMarker = { epoch: string | null; version: number }

// Reject only older versions in the same epoch; equal versions must reprocess tombstone expiry, and a new publisher resets the floor.
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

export function confirmsMirroredTabSelection(publicationEpoch?: string): boolean {
  // Why: phone-local persistence acknowledges the mutation, not host focus;
  // keep the pending guard until any host publication confirms the selection.
  return !publicationEpoch?.startsWith('mobile-local:')
}

// Hide locally closed tabs until host absence confirms them; expire tombstones so failed closes cannot hide live tabs forever.
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
