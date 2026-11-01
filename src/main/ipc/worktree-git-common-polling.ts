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

export type GitCommonPollingOptions = {
  /** Reconciliation directly probes in-place leaves each tick and forces a full sweep every N ticks. */
  reconciliationFullScanEveryTicks?: number
  /** Missing snapshots can outlive the native owner they originally retired. */
  onRootMissing?: (initial: boolean) => void
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
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  const reconciliationFullScanEveryTicks = options.reconciliationFullScanEveryTicks
  const isReconciliation = reconciliationFullScanEveryTicks !== undefined
  // Filesystems can ignore child renames in directory metadata; detected misses force ungated sweeps.
  let entryDirGateTrusted = true
  let dirGateMissTicks = 0
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
    tickCount++
    const shouldForceFullScan =
      (isReconciliation && !entryDirGateTrusted) ||
      forceFullScan ||
      tickCount % (reconciliationFullScanEveryTicks ?? INDEX_BACKSTOP_TICKS) === 0
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
    // Resume must force index reads because hidden writes can leave directory signatures unchanged.
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
