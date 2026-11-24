import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { forEachWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import { createOnDemandScanGate } from './worktree-git-common-on-demand-scan-gate'
import {
  diffGitCommon,
  gitCommonDirectoryIdentity,
  type GitCommonSnapshot
} from './worktree-git-common-snapshot-diff'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from '../creation/worktree-base-directory-poller'
import {
  gitCommonDirectorySignature,
  gitCommonFileSignature,
  snapshotGitCommonEntry,
  type GitCommonEntrySnapshot
} from './worktree-git-common-entry-snapshot'

// Ungated backstops bound missed same-granule index writes on coarse-timestamp filesystems.
const INDEX_BACKSTOP_TICKS = 15

// Match existing probe pools to bound fleet stat fanout without flooding libuv (#17828).
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
  statusRefPaths = new Set<string>(),
  statInPlaceLeaves = false,
  onDirGateMiss?: () => void,
  onRootMissing?: () => void
): Promise<GitCommonSnapshot> {
  const worktreesDir = join(commonDirPath, 'worktrees')
  const [worktreesDirSignature, primarySignatures, statusRefSignatures] = await Promise.all([
    gitCommonDirectorySignature(worktreesDir, previous?.worktreesDirSignature, onRootMissing),
    includePrimary ? snapshotPrimaryCheckoutSignatures(commonDirPath) : new Map<string, string>(),
    snapshotStatusRefSignatures(statusRefPaths)
  ])
  // List every tick: coarse directory signatures can miss add/remove changes before the slow backstop.
  let entryPaths: string[]
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    entryPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(worktreesDir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      entryPaths = []
    } else {
      // Transient readdir failures are not deletion proof; retain entries and let their own stats detect removals.
      entryPaths = previous ? [...previous.entries.keys()] : []
    }
  }

  const entries = new Map<string, GitCommonEntrySnapshot>()
  await forEachWithConcurrency(entryPaths, GIT_COMMON_SNAPSHOT_CONCURRENCY, async (entryPath) => {
    const previousEntry = previous?.entries.get(entryPath)
    entries.set(
      entryPath,
      await snapshotGitCommonEntry(
        entryPath,
        previousEntry,
        forceFullScan,
        statInPlaceLeaves,
        onDirGateMiss
      )
    )
  })
  // Full-scan metrics count ungated metadata sweeps, not the cheap per-tick directory listing.
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

export type GitCommonPollingSubscription = WorktreeBaseSubscription & {
  /** Run a gated check now without moving the timed sweep; false when skipped (busy, hidden or scanned recently). */
  poke: () => boolean
}

export type GitCommonPollingOptions = {
  /** Reconciliation directly probes in-place leaves each tick and forces a full sweep every N ticks. */
  reconciliationFullScanEveryTicks?: number
  /** Missing snapshots can outlive the native owner they originally retired. */
  onRootMissing?: (initial: boolean) => void
  /** Pokes skip when any scan started this recently; a reveal forces a sweep when the hide spanned an old tick this far apart. */
  minOnDemandScanIntervalMs?: number
}

// Require misses on separate ticks before distrusting the directory gate for the whole catalog.
const DIR_GATE_MISS_TICKS_TO_DISTRUST = 2

export async function startGitCommonPolling(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  includePrimary = true,
  getStatusRefPaths: () => readonly string[] = () => [],
  options: GitCommonPollingOptions = {}
): Promise<GitCommonPollingSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  const reconciliationFullScanEveryTicks = options.reconciliationFullScanEveryTicks
  const isReconciliation = reconciliationFullScanEveryTicks !== undefined
  // Filesystems can ignore child renames in directory metadata; detected misses force ungated sweeps.
  let entryDirGateTrusted = true
  let dirGateMissTicks = 0
  const onDemand = createOnDemandScanGate(options.minOnDemandScanIntervalMs, visibility)
  let pokeAfterScan = false
  let snapshot = await snapshotGitCommon(
    commonDirPath,
    undefined,
    includePrimary,
    false,
    new Set(getStatusRefPaths()),
    false,
    undefined,
    () => options.onRootMissing?.(true)
  )
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

  // A poke leaves the timed chain alone; a timed tick that lands mid-poke runs once the poke ends.
  let deferredTimedTick: { forceFullScan: boolean } | null = null
  const tick = async (forceFullScan = false, poked = false): Promise<void> => {
    if (!poked) {
      if (timer) {
        clearTimeout(timer)
      }
      timer = null
    }
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      if (!poked) {
        parkedWhileHidden = true
      }
      return
    }
    if (ticking) {
      if (!poked) {
        deferredTimedTick = { forceFullScan: forceFullScan || !!deferredTimedTick?.forceFullScan }
      }
      return
    }
    ticking = true
    onDemand.scanStarted(!poked)
    // Measure start-to-start cadence so scan duration does not add a full interval of lag.
    const startedAt = Date.now()
    if (!poked) {
      tickCount++
    }
    const shouldForceFullScan =
      (isReconciliation && !entryDirGateTrusted) ||
      forceFullScan ||
      (!poked && tickCount % (reconciliationFullScanEveryTicks ?? INDEX_BACKSTOP_TICKS) === 0)
    let dirGateMissed = false
    try {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot,
        includePrimary,
        shouldForceFullScan,
        new Set(getStatusRefPaths()),
        isReconciliation,
        isReconciliation
          ? () => {
              dirGateMissed = true
            }
          : undefined,
        // A present-to-missing edge already retires through the normal diff.
        snapshot.worktreesDirSignature === 'missing'
          ? () => options.onRootMissing?.(false)
          : undefined
      )
      if (disposed) {
        return
      }
      if (dirGateMissed && ++dirGateMissTicks >= DIR_GATE_MISS_TICKS_TO_DISTRUST) {
        entryDirGateTrusted = false
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
    if (pokeAfterScan && !disposed) {
      pokeAfterScan = false
      onDemand.retryWhenOpen(poke)
    }
    if (disposed) {
      return
    }
    if (poked) {
      const deferred = deferredTimedTick
      deferredTimedTick = null
      if (deferred && !timer) {
        void tick(deferred.forceFullScan)
      }
      return
    }
    const deferred = deferredTimedTick
    deferredTimedTick = null
    if (deferred?.forceFullScan) {
      void tick(true)
      return
    }
    // Clamp wall-clock jumps so NTP cannot postpone refreshes beyond one interval.
    const nextDelay = Math.max(
      0,
      Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
    )
    timer = setTimeout(() => void tick(), nextDelay)
    timer.unref?.()
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    const spannedOldTick = onDemand.hideSpannedOldTick()
    onDemand.clearHide()
    if (disposed || (!parkedWhileHidden && !spannedOldTick)) {
      return
    }
    parkedWhileHidden = false
    // Resume must force index reads because hidden writes can leave directory signatures unchanged.
    void tick(true)
  })

  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  function poke(): boolean {
    // A pending reveal sweep supersedes the gated check (focus can arrive before show/restore).
    const revealPending = parkedWhileHidden || onDemand.hideSpannedOldTick()
    if (disposed || revealPending || !visibility.isWindowVisible()) {
      return false
    }
    // A running scan (possibly stalled on a hung mount) re-arms the retry only when it ends.
    if (ticking) {
      pokeAfterScan = true
      return false
    }
    if (onDemand.scannedRecently()) {
      onDemand.retryWhenOpen(poke)
      return false
    }
    void tick(false, true)
    return true
  }

  return {
    poke,
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
      onDemand.dispose()
    }
  }
}
