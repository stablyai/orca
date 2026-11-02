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

// Coarse timestamps and expired marker probes can miss changes; ungated backstops ensure convergence.
export const WORKTREE_BASE_BACKSTOP_TICKS = 15

// Worktree .git markers arrive early; expire fast probes and let backstops cover unfinished directories.
const PENDING_MARKER_MAX_TICKS = 300

// Bound metadata fanout to match Git-common polling without flooding libuv (#17828).
export const MARKER_PROBE_CONCURRENCY = 8

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
  // Listings of these root/container directories define the candidates and gate rescans.
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

// Match flat and nested layouts at the same depths as the native event filter.
async function snapshotBase(
  rootPath: string,
  repos: ReadonlyMap<string, WorktreeBaseRepoWatchConfig>
): Promise<BaseSnapshot> {
  const markers = new Map<string, boolean>()
  const gateDirs = [rootPath]
  // Sample before listing so racing writes invalidate the next tick instead of waiting for the backstop.
  const gateSignatures = [await dirSignature(rootPath)]
  const configs = [...repos.values()]
  const includeFlat = configs.some((config) => !config.nestWorkspaces)
  const nestedRepoNames = new Set(
    configs
      .filter((config) => config.nestWorkspaces)
      .map((config) => normalizeRuntimePathForComparison(config.repoName))
  )

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
    const dueDirs: string[] = []
    for (const [dir, firstSeenTick] of markerProbeStartedAt) {
      if (firstSeenTick === null) {
        continue
      }
      if (tickCount - firstSeenTick > pendingMarkerMaxTicks) {
        markerProbeStartedAt.set(dir, null)
        continue
      }
      dueDirs.push(dir)
    }
    const events: WorktreeBasePollEvent[] = []
    // Bound pending-marker probes too, especially for WSL or network-backed base paths.
    await forEachWithConcurrency(dueDirs, MARKER_PROBE_CONCURRENCY, async (dir) => {
      options.onPendingMarkerProbe?.(join(dir, '.git'))
      if (await hasGitMarker(dir)) {
        markerProbeStartedAt.delete(dir)
        snapshot.markers.set(dir, true)
        events.push({ type: 'create', path: join(dir, '.git') })
      }
    })
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
    // Unchanged candidate-listing directories skip readdir and per-marker fanout.
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
    // Measure start-to-start cadence so scan duration does not add a full interval of lag.
    const startedAt = Date.now()
    try {
      await poll(forceFullScan)
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Clamp wall-clock jumps so NTP cannot postpone refreshes beyond one interval.
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
    // Resume forces a full diff because hidden same-granule changes can evade directory signatures.
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
