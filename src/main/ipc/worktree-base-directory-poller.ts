import { isMainWindowVisible, onMainWindowBecameVisible } from '../window/main-window-visibility'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import { startBasePoller } from './worktree-base-directory-marker-poller'
import { startGitCommonWatch } from './worktree-git-common-watch'

export type WorktreeBasePollEvent = { type: 'create' | 'update' | 'delete'; path: string }

export type WorktreeBaseSubscription = { unsubscribe: () => Promise<void> }

export type WorktreePollerWindowVisibility = {
  isWindowVisible: () => boolean
  onWindowBecameVisible: (listener: () => void) => () => void
}

type WorktreePollerWindow = {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  isMinimized?: () => boolean
}

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

export function createWorktreePollerWindowVisibility(
  getWindow: () => WorktreePollerWindow | null
): WorktreePollerWindowVisibility {
  // Never-shown or absent windows lack a future reveal signal; park only previously visible windows now hidden.
  let hasBeenVisible = false
  return {
    isWindowVisible: () => {
      const window = getWindow()
      if (window === null || window.isDestroyed()) {
        return true
      }
      if (isMainWindowVisible(window)) {
        hasBeenVisible = true
        return true
      }
      return !hasBeenVisible
    },
    onWindowBecameVisible: onMainWindowBecameVisible
  }
}

export type WorktreeBasePollerOptions = {
  pollIntervalMs?: number
  platform?: NodeJS.Platform
  visibility?: WorktreePollerWindowVisibility
  getGitStatusRefPaths?: () => readonly string[]
  onWatchError?: (error: Error) => void
  /** Called when the watcher child dropped an event batch (git-common narrow watch only). */
  onOverflow?: () => void
  /** Test hook: called whenever a full snapshot scan runs (vs. a gated skip). */
  onFullScan?: () => void
  /** Test hook: called before a pending `.git` marker stat. */
  onPendingMarkerProbe?: (path: string) => void
  /** Test hook: awaited with the tick after a full scan's listings, to land a racing write. */
  onSnapshotTaken?: (tick: number) => void | Promise<void>
  /** Test hook: overrides the fast-probe window. */
  pendingMarkerMaxTicks?: number
}

// Shallow polling avoids recursive FSEvents churn; two-second discovery complements immediate Orca mutation notifications.
export const WORKTREE_BASE_POLL_INTERVAL_MS = 2_000

/** Resolve after the shallow baseline snapshot or native subscription is established. */
export async function startWorktreeBaseDirectoryPoller(
  target: WorktreeBaseWatchTarget,
  getRepos: () => ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  options: WorktreeBasePollerOptions = {}
): Promise<WorktreeBaseSubscription> {
  const pollIntervalMs = options.pollIntervalMs ?? WORKTREE_BASE_POLL_INTERVAL_MS
  const platform = options.platform ?? process.platform
  const visibility = options.visibility ?? alwaysVisible
  if (target.kind === 'git-common') {
    return startGitCommonWatch(
      target,
      onEvents,
      pollIntervalMs,
      platform,
      visibility,
      options.onFullScan,
      options.getGitStatusRefPaths,
      options.onWatchError,
      options.onOverflow
    )
  }
  return startBasePoller(target, getRepos, onEvents, pollIntervalMs, visibility, options)
}
