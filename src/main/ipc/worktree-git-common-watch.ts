import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'
import { startGitCommonPrimaryWatch } from './worktree-git-common-primary-watch'
import { startGitCommonPolling } from './worktree-git-common-polling'

// Local macOS, Linux, and Windows use the crash-isolated native stream for the
// narrow `worktrees/` tree and primary metadata leaves. Selected upstream refs
// stay on the scheduler's bounded stat path. Unsupported platforms retain the
// full polling fallback.

const NARROW_WATCH_PLATFORMS: Partial<Record<NodeJS.Platform, true>> = {
  darwin: true,
  linux: true,
  win32: true
}

function supportsNarrowWatch(platform: NodeJS.Platform): boolean {
  return NARROW_WATCH_PLATFORMS[platform] === true
}

export async function startGitCommonWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  getStatusRefPaths: () => readonly string[] = () => [],
  onWatchError?: (error: Error) => void,
  onOverflow?: () => void
): Promise<WorktreeBaseSubscription> {
  if (supportsNarrowWatch(platform)) {
    const [narrowWatch, primaryWatch] = await Promise.all([
      startGitCommonNarrowWatch(
        target,
        onEvents,
        pollIntervalMs,
        platform,
        visibility,
        onFullScan,
        onWatchError,
        onOverflow
      ),
      startGitCommonPrimaryWatch(
        target.path,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan,
        onWatchError
      )
    ])
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryWatch.unsubscribe()])
      }
    }
  }
  // Why: Electron only ships darwin/linux/win32, all covered by NARROW_WATCH_PLATFORMS
  // above, so this branch is defensive dead code in production, not a reachable fallback.
  return startGitCommonPolling(
    target.path,
    onEvents,
    pollIntervalMs,
    visibility,
    onFullScan,
    true,
    getStatusRefPaths
  )
}
