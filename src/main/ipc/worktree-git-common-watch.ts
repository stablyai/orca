import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription
} from './worktree-base-directory-poller'

// Watches a repo's `<common>/.git/worktrees` metadata plus the primary
// checkout's shallow branch/index files — the only paths the git-common event
// filter consumes.
// macOS: a narrow native stream rooted at `worktrees/` — a tiny, rare-churn
// tree — gives instant detection with zero idle cost and zero wide-scope
// fseventsd delivery; the primary files are covered by a few stat calls per
// tick (a native stream would have to span the whole common dir, objects
// included). Other platforms: dir-listing poll (no fseventsd to protect, and
// on Windows an open directory handle on `worktrees/` could interfere with
// `git worktree prune` removing it).

// Why: branch switches and commits made in the primary checkout rewrite these
// top-level files (linked-worktree equivalents live under `worktrees/`).
// Deliberately excludes FETCH_HEAD-style churn that carries no status change.
const PRIMARY_CHECKOUT_METADATA_FILES = ['HEAD', 'packed-refs', 'index']

async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string
): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>()
  for (const name of PRIMARY_CHECKOUT_METADATA_FILES) {
    const filePath = join(commonDirPath, name)
    try {
      mtimes.set(filePath, (await stat(filePath)).mtimeMs)
    } catch {
      // Missing file (e.g. no packed-refs yet) diffs into a create later.
    }
  }
  return mtimes
}

async function snapshotGitCommon(commonDirPath: string): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>()
  const worktreesDir = join(commonDirPath, 'worktrees')
  let entries
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true })
  } catch {
    // Missing worktrees dir is normal for repos without linked worktrees.
    return mtimes
  }
  for (const entry of entries) {
    const entryPath = join(worktreesDir, entry.name)
    try {
      // Entry-dir mtime covers the metadata writes the old recursive watcher
      // reacted to (HEAD/gitdir/locked are written via rename into the entry
      // dir, which bumps its mtime).
      mtimes.set(entryPath, (await stat(entryPath)).mtimeMs)
    } catch {
      // Entry removed between readdir and stat.
    }
  }
  return mtimes
}

function diffGitCommon(
  prev: Map<string, number>,
  next: Map<string, number>
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  for (const [entryPath, mtime] of next) {
    const prevMtime = prev.get(entryPath)
    if (prevMtime === undefined) {
      events.push({ type: 'create', path: entryPath })
    } else if (prevMtime !== mtime) {
      events.push({ type: 'update', path: entryPath })
    }
  }
  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
    }
  }
  return events
}

async function startSnapshotDiffPoller(
  takeSnapshot: () => Promise<Map<string, number>>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let snapshot = await takeSnapshot()

  const timer = setInterval(() => {
    if (disposed || ticking) {
      return
    }
    ticking = true
    onFullScan?.()
    void takeSnapshot()
      .then((next) => {
        if (disposed) {
          return
        }
        const events = diffGitCommon(snapshot, next)
        snapshot = next
        if (events.length > 0) {
          onEvents(events)
        }
      })
      .catch(() => {
        // Transient fs error: keep the previous snapshot and retry next tick.
      })
      .finally(() => {
        ticking = false
      })
  }, pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      clearInterval(timer)
    }
  }
}

async function snapshotGitCommonAndPrimaryMetadata(
  commonDirPath: string
): Promise<Map<string, number>> {
  const [worktrees, primary] = await Promise.all([
    snapshotGitCommon(commonDirPath),
    snapshotPrimaryCheckoutMetadata(commonDirPath)
  ])
  for (const [path, mtime] of primary) {
    worktrees.set(path, mtime)
  }
  return worktrees
}

async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  let subscribing = false

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
  }

  const armExistencePoll = (): void => {
    if (disposed || existenceTimer) {
      return
    }
    existenceTimer = setInterval(() => {
      if (disposed || subscribing || subscription) {
        return
      }
      subscribing = true
      void trySubscribe()
        .then((installed) => {
          if (installed && !disposed) {
            stopExistencePoll()
            // The dir appearing means a first linked worktree was just
            // registered; surface it so the repo's worktree list refreshes.
            onEvents([{ type: 'create', path: worktreesDir }])
          }
        })
        .finally(() => {
          subscribing = false
        })
    }, pollIntervalMs)
    existenceTimer.unref?.()
  }

  const trySubscribe = async (): Promise<boolean> => {
    try {
      const s = await stat(worktreesDir)
      if (!s.isDirectory()) {
        return false
      }
    } catch {
      return false
    }
    let errored = false
    // Why: parcel tears its native stream down when the watched root is
    // deleted (e.g. `git worktree prune` removing an empty worktrees dir) —
    // sometimes surfaced as an error, sometimes as a delete event for the
    // root. Either way: notify, drop the dead stream, and let the existence
    // poll re-arm when a future worktree add recreates the dir.
    const teardownAndRearm = (): void => {
      errored = true
      const current = subscription
      subscription = null
      if (current) {
        void current.unsubscribe().catch(() => {})
      }
      armExistencePoll()
    }
    try {
      const watcher = await import('@parcel/watcher')
      const sub = await watcher.subscribe(worktreesDir, (error, events) => {
        if (disposed) {
          return
        }
        if (error) {
          onEvents([{ type: 'update', path: worktreesDir }])
          teardownAndRearm()
          return
        }
        if (events.length > 0) {
          const rootGone = events.some(
            (event) => event.type === 'delete' && event.path === worktreesDir
          )
          onEvents(events.map((event) => ({ type: event.type, path: event.path })))
          if (rootGone) {
            teardownAndRearm()
          }
        }
      })
      if (disposed || errored) {
        void sub.unsubscribe().catch(() => {})
        return !errored
      }
      subscription = { unsubscribe: () => sub.unsubscribe() }
      return true
    } catch {
      return false
    }
  }

  if (!(await trySubscribe())) {
    armExistencePoll()
  }

  return {
    unsubscribe: async () => {
      disposed = true
      stopExistencePoll()
      const current = subscription
      subscription = null
      if (current) {
        await current.unsubscribe().catch(() => {})
      }
    }
  }
}

export async function startGitCommonWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  if (platform === 'darwin') {
    const [narrowWatch, primaryMetadataPoll] = await Promise.all([
      startGitCommonNarrowWatch(target, onEvents, pollIntervalMs),
      startSnapshotDiffPoller(
        () => snapshotPrimaryCheckoutMetadata(target.path),
        onEvents,
        pollIntervalMs,
        onFullScan
      )
    ])
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryMetadataPoll.unsubscribe()])
      }
    }
  }
  return startSnapshotDiffPoller(
    () => snapshotGitCommonAndPrimaryMetadata(target.path),
    onEvents,
    pollIntervalMs,
    onFullScan
  )
}
