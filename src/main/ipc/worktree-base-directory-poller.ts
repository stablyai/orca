import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import { startGitCommonWatch } from './worktree-git-common-watch'

export type WorktreeBasePollEvent = { type: 'create' | 'update' | 'delete'; path: string }

export type WorktreeBaseSubscription = { unsubscribe: () => Promise<void> }

export type WorktreeBasePollerOptions = {
  pollIntervalMs?: number
  platform?: NodeJS.Platform
  /** Test hook: called whenever a full snapshot scan runs (vs. a gated skip). */
  onFullScan?: () => void
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

// Why: the mtime gate is an optimization, not a correctness boundary — some
// filesystems have coarse dir timestamps, and pending `.git` markers expire.
// A periodic ungated scan guarantees eventual convergence.
export const WORKTREE_BASE_BACKSTOP_TICKS = 15

// Why: a `.git` completion marker lands within moments of its worktree dir
// (git writes it before populating the checkout). Dirs that never get one are
// not worktrees; stop re-statting them after this many ticks and let the
// backstop scan cover the pathological case.
const PENDING_MARKER_MAX_TICKS = 300

function statSignature(s: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
}

async function dirSignature(path: string): Promise<string> {
  try {
    return statSignature(await stat(path))
  } catch {
    return 'missing'
  }
}

async function hasGitMarker(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

type BaseSnapshot = {
  // worktree-candidate dir → whether its `.git` completion marker exists
  markers: Map<string, boolean>
  // dirs whose listing determines the candidate set: the root plus any
  // nested repo containers. Their stat signatures gate the next full scan.
  gateDirs: string[]
}

// Depth-1 worktree dirs (flat layout), plus depth-2 dirs under each nested
// repo's container, mirroring what worktree-base-directory-event-filter
// matches: `<wt>/.git` completion markers and `<wt>` deletions.
async function snapshotBase(
  rootPath: string,
  repos: ReadonlyMap<string, WorktreeBaseRepoWatchConfig>
): Promise<BaseSnapshot> {
  const markers = new Map<string, boolean>()
  const gateDirs = [rootPath]
  const configs = [...repos.values()]
  const includeFlat = configs.some((config) => !config.nestWorkspaces)
  const nestedRepoNames = new Set(
    configs
      .filter((config) => config.nestWorkspaces)
      .map((config) => normalizeRuntimePathForComparison(config.repoName))
  )

  let rootEntries
  try {
    rootEntries = await readdir(rootPath, { withFileTypes: true })
  } catch {
    // Root vanished: an empty snapshot diffs into delete events for every
    // previously-known worktree dir, matching the old watcher's error path.
    return { markers, gateDirs }
  }

  const candidates: string[] = []
  for (const entry of rootEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }
    const entryPath = join(rootPath, entry.name)
    if (includeFlat) {
      candidates.push(entryPath)
    }
    if (nestedRepoNames.has(normalizeRuntimePathForComparison(entry.name))) {
      gateDirs.push(entryPath)
      let subEntries
      try {
        subEntries = await readdir(entryPath, { withFileTypes: true })
      } catch {
        subEntries = []
      }
      for (const sub of subEntries) {
        if (sub.isDirectory() || sub.isSymbolicLink()) {
          candidates.push(join(entryPath, sub.name))
        }
      }
    }
  }

  for (const dir of candidates) {
    markers.set(dir, await hasGitMarker(dir))
  }
  return { markers, gateDirs }
}

function diffBase(prev: BaseSnapshot, next: BaseSnapshot): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  for (const [dir, marker] of next.markers) {
    if (marker && prev.markers.get(dir) !== true) {
      events.push({ type: 'create', path: join(dir, '.git') })
    }
  }
  for (const dir of prev.markers.keys()) {
    if (!next.markers.has(dir)) {
      events.push({ type: 'delete', path: dir })
    }
  }
  return events
}

async function startBasePoller(
  target: WorktreeBaseWatchTarget,
  getRepos: () => ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  let snapshot = await snapshotBase(target.path, getRepos())
  let gateSignatures = await Promise.all(snapshot.gateDirs.map(dirSignature))
  // dir → tick when first seen without a `.git` marker
  const pendingMarkers = new Map<string, number>()
  for (const [dir, marker] of snapshot.markers) {
    if (!marker) {
      pendingMarkers.set(dir, 0)
    }
  }

  const fullScan = async (): Promise<void> => {
    onFullScan?.()
    const next = await snapshotBase(target.path, getRepos())
    const nextSignatures = await Promise.all(next.gateDirs.map(dirSignature))
    if (disposed) {
      return
    }
    const events = diffBase(snapshot, next)
    for (const [dir, marker] of next.markers) {
      if (marker) {
        pendingMarkers.delete(dir)
      } else if (!pendingMarkers.has(dir)) {
        pendingMarkers.set(dir, tickCount)
      }
    }
    for (const [dir, firstSeenTick] of pendingMarkers) {
      if (!next.markers.has(dir) || tickCount - firstSeenTick > PENDING_MARKER_MAX_TICKS) {
        pendingMarkers.delete(dir)
      }
    }
    snapshot = next
    gateSignatures = nextSignatures
    if (events.length > 0) {
      onEvents(events)
    }
  }

  const checkPendingMarkers = async (): Promise<void> => {
    const events: WorktreeBasePollEvent[] = []
    for (const dir of pendingMarkers.keys()) {
      if (await hasGitMarker(dir)) {
        pendingMarkers.delete(dir)
        snapshot.markers.set(dir, true)
        events.push({ type: 'create', path: join(dir, '.git') })
      }
    }
    if (!disposed && events.length > 0) {
      onEvents(events)
    }
  }

  const tick = async (): Promise<void> => {
    tickCount++
    if (tickCount % WORKTREE_BASE_BACKSTOP_TICKS === 0) {
      await fullScan()
      return
    }
    // Idle fast path: when the dirs whose listings define the candidate set
    // are untouched, skip the readdir + per-candidate stat fan-out entirely.
    const signatures = await Promise.all(snapshot.gateDirs.map(dirSignature))
    const gateChanged =
      signatures.length !== gateSignatures.length ||
      signatures.some((sig, index) => sig !== gateSignatures[index])
    if (gateChanged) {
      await fullScan()
      return
    }
    if (pendingMarkers.size > 0) {
      await checkPendingMarkers()
    }
  }

  const timer = setInterval(() => {
    if (disposed || ticking) {
      return
    }
    ticking = true
    void tick()
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
  if (target.kind === 'git-common') {
    return startGitCommonWatch(target, onEvents, pollIntervalMs, platform, options.onFullScan)
  }
  return startBasePoller(target, getRepos, onEvents, pollIntervalMs, options.onFullScan)
}
