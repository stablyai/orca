import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { forEachWithConcurrency } from '../../shared/map-with-concurrency'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import {
  diffGitCommon,
  gitCommonDirectoryIdentity,
  type GitCommonSnapshot
} from './worktree-git-common-snapshot-diff'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import {
  gitCommonDirectorySignature,
  gitCommonFileSignature,
  snapshotGitCommonEntry,
  type GitCommonEntrySnapshot
} from './worktree-git-common-entry-snapshot'

// Why: the entry-dir signature gate can miss same-granule index rewrites on
// coarse-mtime filesystems; a periodic ungated re-stat bounds that miss the
// same way the base poller's backstop rescan does.
const INDEX_BACKSTOP_TICKS = 15

// Why: an unbounded fan-out across every worktree admin entry (~7 stats each)
// queues thousands of ops on libuv's 4-thread default pool, starving every
// other main-process fs call for the scan's duration (#17828). 8 mirrors the
// existing head-identity/exact-ref-probe pools — enough to saturate typical
// local disks without monopolizing the pool.
const GIT_COMMON_SNAPSHOT_CONCURRENCY = 8

// Why: on hosts without native narrow-watch support (or once its crash fuse
// trips), the O(n) per-entry sweep below is the only source of per-worktree
// change detection — a fixed 2s cadence at hundreds of worktrees turns it into
// a near-permanent scan loop. Only the sweep's own cadence stretches (see
// `shouldSweep` in startGitCommonPolling); the cheap structural tripwire
// (readdir, dir signature, primary files, newly-added entries) stays on the
// fixed `pollIntervalMs` so worktree add/remove and HEAD changes never inherit
// this stretch.
const ADAPTIVE_CADENCE_TARGET_DUTY_CYCLE = 0.1
const ADAPTIVE_CADENCE_MAX_INTERVAL_MS = 30_000

function computeAdaptiveIntervalMs(baseIntervalMs: number, lastScanDurationMs: number): number {
  return Math.min(
    ADAPTIVE_CADENCE_MAX_INTERVAL_MS,
    Math.max(baseIntervalMs, lastScanDurationMs / ADAPTIVE_CADENCE_TARGET_DUTY_CYCLE)
  )
}

async function snapshotStatusRefSignatures(
  paths: ReadonlySet<string>
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>()
  await forEachWithConcurrency([...paths], GIT_COMMON_SNAPSHOT_CONCURRENCY, async (path) => {
    const signature = await gitCommonFileSignature(path)
    if (signature !== null) {
      signatures.set(path, signature)
    }
  })
  return signatures
}

async function snapshotPrimaryCheckoutSignatures(
  commonDirPath: string
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>()
  await Promise.all(
    PRIMARY_CHECKOUT_METADATA_FILES.map(async (name) => {
      const signature = await gitCommonFileSignature(join(commonDirPath, name))
      if (signature !== null) {
        signatures.set(name, signature)
      }
    })
  )
  return signatures
}

async function snapshotGitCommon(
  commonDirPath: string,
  previous?: GitCommonSnapshot,
  includePrimary = true,
  forceFullScan = false,
  statusRefPaths = new Set<string>(),
  // Why: false on a tripwire-only tick (adaptive cadence, sweep not yet due) — carries
  // over unchanged entries and only stats genuinely new ones, instead of O(n) re-stats.
  sweepEntries = true
): Promise<GitCommonSnapshot> {
  const worktreesDir = join(commonDirPath, 'worktrees')
  const [worktreesDirSignature, primarySignatures, statusRefSignatures] = await Promise.all([
    gitCommonDirectorySignature(worktreesDir),
    includePrimary ? snapshotPrimaryCheckoutSignatures(commonDirPath) : new Map<string, string>(),
    snapshotStatusRefSignatures(statusRefPaths)
  ])
  // Why: enumerate the worktrees dir EVERY tick rather than gating the readdir on its stat signature.
  // A single readdir of a small dir is negligible next to the per-entry structural stats that already
  // run each tick, and the signature gate could miss a same-granule add+remove on a coarse-mtime/FAT
  // filesystem (its size/mtime/ino/ctime all collide), leaving a linked worktree add/remove undetected
  // until the ~30s index backstop (#9882 review). The listing is the authoritative add/remove signal.
  let entryPaths: string[]
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    entryPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(worktreesDir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Dir genuinely absent (no linked worktrees, or all removed) → authoritative empty listing.
      entryPaths = []
    } else {
      // Why: a TRANSIENT readdir failure (EIO/ESTALE/EMFILE, network/SSH hiccup) must not masquerade as
      // "every worktree removed" — that would emit false delete events (and false creates next tick).
      // Reuse the known entries so per-entry stats still run; a real removal surfaces as that entry's own
      // stat miss (handled in snapshotGitCommonEntry), and the next successful readdir catches any add.
      entryPaths = previous ? [...previous.entries.keys()] : []
    }
  }

  const entryPathSet = new Set(entryPaths)
  const entries = new Map<string, GitCommonEntrySnapshot>(previous?.entries)
  for (const entryPath of entries.keys()) {
    if (!entryPathSet.has(entryPath)) {
      entries.delete(entryPath)
    }
  }
  // Why: a tripwire-only tick still stats brand-new entries (bounded by how many
  // worktrees actually appeared this tick, not total count) so adds show up immediately.
  const pathsToSnapshot = sweepEntries
    ? entryPaths
    : entryPaths.filter((path) => !entries.has(path))
  await forEachWithConcurrency(
    pathsToSnapshot,
    GIT_COMMON_SNAPSHOT_CONCURRENCY,
    async (entryPath) => {
      const previousEntry = previous?.entries.get(entryPath)
      entries.set(entryPath, await snapshotGitCommonEntry(entryPath, previousEntry, forceFullScan))
    }
  )
  // Why: the expensive per-entry `index` read stays gated on each entry's own dir signature; onFullScan
  // now reflects an ungated index-metadata backstop fan-out (forceFullScan) — the real periodic cost —
  // rather than the always-run worktrees-dir readdir.
  return {
    worktreesDirSignature,
    worktreesDirIdentity: gitCommonDirectoryIdentity(worktreesDirSignature),
    entries,
    primarySignatures,
    statusRefPaths,
    statusRefSignatures,
    didFullScan: forceFullScan && sweepEntries
  }
}

export type GitCommonPollingOptions = {
  /** Reconciliation backstop: never trust the per-entry gate, re-stat every tick. */
  forceFullScanEveryTick?: boolean
  /** This is the ONLY signal (no native watch, or its crash fuse tripped): stretch the
   *  O(n) per-entry sweep's cadence when entry count makes it take a large fraction of
   *  the interval. The cheap structural tripwire (add/remove, HEAD) stays on `pollIntervalMs`. */
  adaptiveCadence?: boolean
}

export async function startGitCommonPolling(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  includePrimary = true,
  getStatusRefPaths: () => readonly string[] = () => [],
  options: GitCommonPollingOptions = {}
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  // Why: 0 (never) rather than seeding from the bootstrap snapshot's duration — the first
  // regular tick already sweeps unconditionally, so no seed heuristic is needed at all.
  let nextSweepDueAt = 0
  let snapshot = await snapshotGitCommon(
    commonDirPath,
    undefined,
    includePrimary,
    false,
    new Set(getStatusRefPaths())
  )
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

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
    // Why: measure from tick start so cadence is start-to-start, not gap-after-completion (which would
    // land each visible refresh a full scan-duration late every tick).
    const startedAt = Date.now()
    tickCount++
    const shouldForceFullScan =
      options.forceFullScanEveryTick === true ||
      forceFullScan ||
      tickCount % INDEX_BACKSTOP_TICKS === 0
    // Why: non-adaptive callers always sweep (unchanged behavior); adaptive callers sweep
    // only when due or forced, so the tripwire below still runs every tick regardless.
    const shouldSweep =
      !options.adaptiveCadence || shouldForceFullScan || Date.now() >= nextSweepDueAt
    try {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot,
        includePrimary,
        shouldForceFullScan,
        new Set(getStatusRefPaths()),
        shouldSweep
      )
      if (disposed) {
        return
      }
      if (shouldSweep && options.adaptiveCadence) {
        nextSweepDueAt =
          Date.now() + computeAdaptiveIntervalMs(pollIntervalMs, Date.now() - startedAt)
      }
      if (next.didFullScan) {
        onFullScan?.()
      }
      const events = diffGitCommon(commonDirPath, snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Why: clamp to [0, pollIntervalMs]. Date.now() is not monotonic — a backward wall-clock jump (NTP) would
      // otherwise make elapsed negative and push the next tick out by the adjustment (suppressing refreshes for
      // minutes); the upper clamp caps the wait at one interval, the lower clamp keeps a long scan from going negative.
      // This stays fixed (never adaptive) so the structural tripwire keeps its `pollIntervalMs` cadence.
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
    // Why: a linked index can change without its parent dir signature moving;
    // force the leaf read when diffing the retained pre-hide snapshot.
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
