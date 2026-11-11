// N-02 backstop: a desktop asks for a full-depth snapshot (5000 rows / 2 MB) only when it holds no
// local copy of the pane, but a client that asks on every reconnect would turn a flaky link into a
// stream of 2 MB snapshots. So each pane gets at most one full-depth snapshot per interval; the rest
// get the 1000-row cut, which is what a reconnecting pane needs to fill its gap.
export const FULL_DEPTH_SNAPSHOT_INTERVAL_MS = 2 * 60_000
// Prune once the map holds this many panes; entries older than the interval no longer limit anything.
const PRUNE_AT_SIZE = 1024

const lastFullDepthAtByPtyId = new Map<string, number>()

/** True when this pane may have a full-depth snapshot now, and records it. */
export function admitFullDepthSnapshot(ptyId: string, now: number = Date.now()): boolean {
  const last = lastFullDepthAtByPtyId.get(ptyId)
  if (last !== undefined && now - last < FULL_DEPTH_SNAPSHOT_INTERVAL_MS) {
    return false
  }
  if (lastFullDepthAtByPtyId.size >= PRUNE_AT_SIZE) {
    for (const [id, at] of lastFullDepthAtByPtyId) {
      if (now - at >= FULL_DEPTH_SNAPSHOT_INTERVAL_MS) {
        lastFullDepthAtByPtyId.delete(id)
      }
    }
  }
  lastFullDepthAtByPtyId.set(ptyId, now)
  return true
}

export function resetFullDepthSnapshotLimitForTests(): void {
  lastFullDepthAtByPtyId.clear()
}
