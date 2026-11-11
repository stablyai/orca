// N-02 backstop for full-depth snapshots (5000 rows / 2 MB). A desktop asks for one only when a
// pane mount holds no local copy of the terminal (fresh mount, app reopen), and names that mount.
// - Per mount: a mount that keeps asking (a reconnect storm before its first history landed) gets
//   at most one per interval; the rest get the 1000-row cut, which fills a reconnecting pane's gap.
// - Per terminal: whatever the mount ids, at most a few per minute, so a client that remounts in a
//   loop (a new id each time) cannot turn a flaky link into a stream of 2 MB snapshots.
// A quit-and-reopen is a new mount, so it always gets depth within those limits.
export const FULL_DEPTH_SNAPSHOT_INTERVAL_MS = 2 * 60_000
export const FULL_DEPTH_SNAPSHOTS_PER_PTY_PER_MINUTE = 3
const MINUTE_MS = 60_000
// Prune once the maps hold this many entries; expired entries no longer limit anything.
const PRUNE_AT_SIZE = 1024

const lastFullDepthAtByMount = new Map<string, number>()
const recentFullDepthAtByPty = new Map<string, number[]>()

/** True when this pane mount may have a full-depth snapshot now, and records it. */
export function admitFullDepthSnapshot(
  ptyId: string,
  mountId: string | undefined,
  now: number = Date.now()
): boolean {
  const mountKey = mountId ? `${ptyId}\u0000${mountId}` : ptyId
  const last = lastFullDepthAtByMount.get(mountKey)
  if (last !== undefined && now - last < FULL_DEPTH_SNAPSHOT_INTERVAL_MS) {
    return false
  }
  const recent = (recentFullDepthAtByPty.get(ptyId) ?? []).filter((at) => now - at < MINUTE_MS)
  if (recent.length >= FULL_DEPTH_SNAPSHOTS_PER_PTY_PER_MINUTE) {
    recentFullDepthAtByPty.set(ptyId, recent)
    return false
  }
  prune(now)
  lastFullDepthAtByMount.set(mountKey, now)
  recentFullDepthAtByPty.set(ptyId, [...recent, now])
  return true
}

function prune(now: number): void {
  if (lastFullDepthAtByMount.size >= PRUNE_AT_SIZE) {
    for (const [key, at] of lastFullDepthAtByMount) {
      if (now - at >= FULL_DEPTH_SNAPSHOT_INTERVAL_MS) {
        lastFullDepthAtByMount.delete(key)
      }
    }
  }
  if (recentFullDepthAtByPty.size >= PRUNE_AT_SIZE) {
    for (const [ptyId, times] of recentFullDepthAtByPty) {
      if (times.every((at) => now - at >= MINUTE_MS)) {
        recentFullDepthAtByPty.delete(ptyId)
      }
    }
  }
}

export function resetFullDepthSnapshotLimitForTests(): void {
  lastFullDepthAtByMount.clear()
  recentFullDepthAtByPty.clear()
}
