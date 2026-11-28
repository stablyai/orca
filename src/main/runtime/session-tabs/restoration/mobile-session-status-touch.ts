import type { MobileSessionTabsAgentStatusHeartbeat } from '../../session-lifecycle/publication/mobile-session-tabs-agent-status-heartbeat'
import type { MobileSessionSnapshotsByWorktree } from '../publication/mobile-session-snapshots-by-worktree'

/** Status bursts bump once per client frame, and only build one when someone listens. */
export function touchMobileSessionStatus(
  worktreeId: string,
  listened: boolean,
  host: {
    heartbeat: Pick<MobileSessionTabsAgentStatusHeartbeat, 'observeWorktreeRefresh'>
    snapshots: MobileSessionSnapshotsByWorktree
    schedule: (worktreeId: string) => void
  }
): void {
  if (!listened) {
    // No frame is built, so this is no refresh: a pending chat heartbeat must still fire.
    host.snapshots.oweUnpublishedVersion(worktreeId)
    return
  }
  host.heartbeat.observeWorktreeRefresh(worktreeId)
  host.snapshots.oweVersion(worktreeId)
  host.schedule(worktreeId)
}
