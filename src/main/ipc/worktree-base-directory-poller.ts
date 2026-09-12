import { isMainWindowVisible, onMainWindowBecameVisible } from '../window/main-window-visibility'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import { startBasePoller } from './worktree-base-directory-marker-poller'
import { startGitCommonWatch } from './worktree-git-common-watch'

export { WORKTREE_BASE_BACKSTOP_TICKS } from './worktree-base-directory-marker-poller'

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
  // Why: only park a window that has actually been shown and is now hidden. A window
  // that has NEVER been shown is either headless (ORCA_E2E_HEADLESS keeps a live but
  // never-shown BrowserWindow) or still starting up — no show/restore signal is coming
  // to resume it, so parking it would starve worktree freshness forever. Treat
  // never-shown as visible and keep polling; only start parking once we've observed the
  // window visible at least once. null/destroyed (serve/headless, macOS window-recreation
  // gap) stay always-visible so a torn-down window never permanently parks the poller.
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

// Why: these targets used to be recursive FSEvents subscriptions spanning the
// entire workspace root (every worktree's full tree) and the repo's whole
// common .git (objects included), forcing fseventsd to deliver all of that
// churn to Orca just to observe a handful of shallow paths. The replacements
// register at most one tiny-scope native stream (macOS git-common) and
// otherwise poll with a dir-mtime gate, so idle cost is a couple of stat
// calls per tick. 2s is fast enough for external `git worktree add/remove`;
// Orca's own worktree operations notify the renderer directly.
export const WORKTREE_BASE_POLL_INTERVAL_MS = 2_000

/** Watches the shallow paths a worktree base target cares about and emits
 *  watcher-shaped events. Resolves once the baseline (snapshot or narrow
 *  native subscription) is established. */
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
