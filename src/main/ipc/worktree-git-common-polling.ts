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

// Why: an unbounded fan-out across every worktree admin entry queues thousands
// of ops on libuv's 4-thread default pool, starving every other main-process
// fs call for the scan's duration (#17828). 8 mirrors the existing
// head-identity/exact-ref-probe pools — enough to saturate typical local
// disks without monopolizing the pool. Since snapshotGitCommonEntry's own
// entry-dir gate (see worktree-git-common-entry-snapshot.ts) keeps most ticks
// down to 1 stat per unchanged entry, real in-flight is now bounded by this
// limit rather than limit × per-entry stat count.
const GIT_COMMON_SNAPSHOT_CONCURRENCY = 8

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
  statusRefPaths = new Set<string>()
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

  const entries = new Map<string, GitCommonEntrySnapshot>()
  await forEachWithConcurrency(entryPaths, GIT_COMMON_SNAPSHOT_CONCURRENCY, async (entryPath) => {
    const previousEntry = previous?.entries.get(entryPath)
    entries.set(entryPath, await snapshotGitCommonEntry(entryPath, previousEntry, forceFullScan))
  })
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
    didFullScan: forceFullScan
  }
}

export type GitCommonPollingOptions = {
  /** Reconciliation backstop: never trust the per-entry gate, re-stat every tick. */
  forceFullScanEveryTick?: boolean
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
    try {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot,
        includePrimary,
        shouldForceFullScan,
        new Set(getStatusRefPaths())
      )
      if (disposed) {
        return
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
