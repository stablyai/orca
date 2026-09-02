import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { forEachWithConcurrency } from '../../shared/map-with-concurrency'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollerOptions,
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Why: the mtime gate is an optimization, not a correctness boundary — some
// filesystems have coarse dir timestamps, and pending `.git` markers expire.
// A periodic ungated scan guarantees eventual convergence.
export const WORKTREE_BASE_BACKSTOP_TICKS = 15

// Why: a `.git` completion marker lands within moments of its worktree dir
// (git writes it before populating the checkout). Dirs that never get one are
// not worktrees; stop re-statting them after this many ticks and let the
// backstop scan cover the pathological case.
const PENDING_MARKER_MAX_TICKS = 300

// Why: matches the git-common poller's fan-out bound (#17828) — bounded
// concurrency turns hundreds of serial round trips into a handful of batches
// without dumping every candidate onto libuv's 4-thread pool at once.
const MARKER_PROBE_CONCURRENCY = 8

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
  // index-aligned with gateDirs, each sampled *before* that dir's listing
  gateSignatures: string[]
}

async function readdirSafe(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
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
  // Why: sampling the signature before the listing makes a write that races the
  // scan look stale next tick (one redundant rescan) instead of invisible until
  // the backstop, which is up to 15 ticks of missed creates/deletes.
  const gateSignatures = [await dirSignature(rootPath)]
  const configs = [...repos.values()]
  const includeFlat = configs.some((config) => !config.nestWorkspaces)
  const nestedRepoNames = new Set(
    configs
      .filter((config) => config.nestWorkspaces)
      .map((config) => normalizeRuntimePathForComparison(config.repoName))
  )

  // Root vanished or unreadable: readdirSafe yields [], producing the same
  // empty markers/candidates result as the old watcher's error path.
  const rootEntries = await readdirSafe(rootPath)

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
      gateSignatures.push(await dirSignature(entryPath))
      const subEntries = await readdirSafe(entryPath)
      for (const sub of subEntries) {
        if (sub.isDirectory() || sub.isSymbolicLink()) {
          candidates.push(join(entryPath, sub.name))
        }
      }
    }
  }

  await forEachWithConcurrency(candidates, MARKER_PROBE_CONCURRENCY, async (dir) => {
    markers.set(dir, await hasGitMarker(dir))
  })
  return { markers, gateDirs, gateSignatures }
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

export async function startBasePoller(
  target: WorktreeBaseWatchTarget,
  getRepos: () => ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  options: WorktreeBasePollerOptions
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  let snapshot = await snapshotBase(target.path, getRepos())
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false
  const pendingMarkerMaxTicks = options.pendingMarkerMaxTicks ?? PENDING_MARKER_MAX_TICKS
  // dir → first probe tick; null means backstop scans only
  const markerProbeStartedAt = new Map<string, number | null>()
  for (const [dir, marker] of snapshot.markers) {
    if (!marker) {
      markerProbeStartedAt.set(dir, 0)
    }
  }

  const fullScan = async (): Promise<void> => {
    options.onFullScan?.()
    const next = await snapshotBase(target.path, getRepos())
    await options.onSnapshotTaken?.(tickCount)
    if (disposed) {
      return
    }
    const events = diffBase(snapshot, next)
    for (const [dir, marker] of next.markers) {
      if (marker) {
        markerProbeStartedAt.delete(dir)
      } else if (!markerProbeStartedAt.has(dir)) {
        markerProbeStartedAt.set(dir, tickCount)
      }
    }
    for (const dir of markerProbeStartedAt.keys()) {
      if (!next.markers.has(dir)) {
        markerProbeStartedAt.delete(dir)
      }
    }
    snapshot = next
    if (events.length > 0) {
      onEvents(events)
    }
  }

  const checkPendingMarkers = async (): Promise<void> => {
    const events: WorktreeBasePollEvent[] = []
    for (const [dir, firstSeenTick] of markerProbeStartedAt) {
      if (firstSeenTick === null) {
        continue
      }
      if (tickCount - firstSeenTick > pendingMarkerMaxTicks) {
        markerProbeStartedAt.set(dir, null)
        continue
      }
      options.onPendingMarkerProbe?.(join(dir, '.git'))
      if (await hasGitMarker(dir)) {
        markerProbeStartedAt.delete(dir)
        snapshot.markers.set(dir, true)
        events.push({ type: 'create', path: join(dir, '.git') })
      }
    }
    if (!disposed && events.length > 0) {
      onEvents(events)
    }
  }

  const poll = async (forceFullScan = false): Promise<void> => {
    tickCount++
    if (forceFullScan || tickCount % WORKTREE_BASE_BACKSTOP_TICKS === 0) {
      await fullScan()
      return
    }
    // Idle fast path: when the dirs whose listings define the candidate set
    // are untouched, skip the readdir + per-candidate stat fan-out entirely.
    const signatures = await Promise.all(snapshot.gateDirs.map(dirSignature))
    const gateChanged =
      signatures.length !== snapshot.gateSignatures.length ||
      signatures.some((sig, index) => sig !== snapshot.gateSignatures[index])
    if (gateChanged) {
      await fullScan()
      return
    }
    if (markerProbeStartedAt.size > 0) {
      await checkPendingMarkers()
    }
  }

  const tick = async (forceFullScan = false): Promise<void> => {
    timer = null
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    if (ticking) {
      return
    }
    ticking = true
    // Why: measure from tick start so the cadence is start-to-start (like the old setInterval), not
    // gap-after-completion — otherwise each visible refresh lands a full scan-duration late every tick.
    const startedAt = Date.now()
    try {
      await poll(forceFullScan)
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Why: clamp to [0, pollIntervalMs]. Date.now() is not monotonic — a backward wall-clock jump (NTP) would
      // otherwise make elapsed negative and push the next tick out by the adjustment (suppressing refreshes for
      // minutes); the upper clamp caps the wait at one interval, the lower clamp keeps a long scan from going negative.
      const nextDelay = Math.max(
        0,
        Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
      )
      timer = setTimeout(() => void tick(), nextDelay)
      timer.unref?.()
    }
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    // Why: the ordinary dir-signature gate can miss same-granule changes made
    // while hidden; resume must diff a fresh full snapshot against the baseline.
    void tick(true)
  })

  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
    }
  }
}
