import {
  addPendingRemoval,
  assertAcceptedBranchChoice,
  settlementsByWorktreeId,
  waitForPendingWorktreeRemoval,
  type RemovalSettlement
} from './worktree-removal-settlement'
export {
  waitForPendingWorktreeRemoval,
  waitForWorktreeRemovalAcceptance,
  finishAcceptedWorktreeRemoval
} from './worktree-removal-settlement'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { normalizeLocalBranchRef } from '../../git/worktrees/worktree-operation-options'
import { acquireWatcherRemovalGate, type WatcherRemovalGate } from './watcher-removal-gate'
import { runWorktreeChangeInvalidators } from '../../ipc/worktrees/listing/worktree-change-invalidators'
import { parseWslPath } from '../../wsl/filesystem/unc-path-access'
import { readWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'
import { failureLeftByGit } from './worktree-removal-failure'
import { differentCheckoutAtPathError, isCheckoutRegistered } from './worktree-removal-leftover'
import {
  closeWorktreeRemovalRecords,
  failedWorktreeRemovals,
  finishedWorktreeRemovals,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords,
  recordedWorktreeRemovals,
  recordWorktreeRemoval,
  setWorktreeRemovalRecordsDirectory
} from './worktree-removal-table'
import {
  worktreeRemovalLifetime,
  _resetWorktreeRemovalLifetimeForTests
} from './worktree-removal-lifetime'

export type BackgroundWorktreeRemovalJob = {
  /** Abort only the checkout delete on orderly quit. */
  run: (stopSignal: AbortSignal) => Promise<RemoveWorktreeResult>
  /** Publish on acceptance and after removing the pending entry. */
  publish: () => void
  /** Clean the push-target remote even when Git partially fails. */
  cleanupPushTargetRemote?: () => Promise<void>
  /** Release teardown fences when durable admission fails before run can take ownership. */
  admissionFailed?: () => Promise<void>
}

const jobsByWorktreeId = new Map<string, Promise<void>>()
// Loaded removals' terminal/watcher fences, held until the resumed job takes its own gate.
const startupFencesByWorktreeId = new Map<string, WatcherRemovalGate>()

/** Load removal fences before session restore can reopen terminals or watchers in incomplete checkouts. */
export async function loadWorktreeRemovalRecords(
  directory: string,
  hasRepo: (repoId: string) => boolean = () => true
): Promise<void> {
  setWorktreeRemovalRecordsDirectory(directory)
  let droppedFailure = false
  for (const record of await readWorktreeRemovalRecords(directory)) {
    if (record.failure) {
      // Removed repos have no listing to clear a failed-removal record.
      if (hasRepo(record.repoId)) {
        failedWorktreeRemovals.set(record.worktreeId, record)
      } else {
        droppedFailure = true
      }
      continue
    }
    if (!pendingWorktreeRemovals.has(record.worktreeId)) {
      recordedWorktreeRemovals.add(record)
      addPendingRemoval(record).accept()
      try {
        startupFencesByWorktreeId.set(
          record.worktreeId,
          acquireWatcherRemovalGate(record.worktreePath)
        )
      } catch {
        // An overlapping loaded removal already fences this path.
      }
    }
  }
  if (droppedFailure) {
    await persistWorktreeRemovalRecords()
  }
}

/** Release in the same tick that the resumed job acquires its own removal gate. */
export function releaseStartupRemovalFence(worktreeId: string): void {
  startupFencesByWorktreeId.get(worktreeId)?.release()
  startupFencesByWorktreeId.delete(worktreeId)
}

export function removesInBackground(
  worktreePath: string,
  options: { wslDistro?: string }
): boolean {
  return !options.wslDistro && !parseWslPath(worktreePath)
}

/** Detach deletion from the request so client disconnects and request timeouts cannot interrupt it. */
export function startBackgroundWorktreeRemoval(
  args: {
    removal: Pick<
      WorktreeRemovalRecord,
      'worktreeId' | 'repoId' | 'repoPath' | 'deleteBranch' | 'force'
    > & { worktree: Pick<GitWorktreeInfo, 'path' | 'branch' | 'head'> }
  } & BackgroundWorktreeRemovalJob
): Promise<RemoveWorktreeResult> {
  const pending = waitForPendingWorktreeRemoval(
    args.removal.worktreeId,
    undefined,
    args.removal.deleteBranch
  )
  if (pending) {
    return pending
  }
  const { worktree, ...accepted } = args.removal
  const record: WorktreeRemovalRecord = {
    ...accepted,
    worktreePath: worktree.path,
    branch: normalizeLocalBranchRef(worktree.branch),
    head: worktree.head,
    requestedAt: Date.now()
  }
  const settlement = addPendingRemoval(record)
  runBackgroundWorktreeRemoval(record, args, recordWorktreeRemoval(record))
  return settlement.result
}

/** Retry only after the folder and Git registration are gone; preserve the originally accepted choices. */
export function retryFailedWorktreeRemoval(
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob,
  force?: boolean,
  deleteBranch?: boolean
): Promise<RemoveWorktreeResult> | undefined {
  const pending = waitForPendingWorktreeRemoval(worktreeId, hostId, deleteBranch)
  if (pending) {
    return pending
  }
  const failed =
    (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
      ? failedWorktreeRemovals.get(worktreeId)
      : undefined
  if (!failed) {
    return waitForPendingWorktreeRemoval(worktreeId, hostId, deleteBranch)
  }
  assertAcceptedBranchChoice(failed, deleteBranch)
  const release = worktreeRemovalLifetime.acquirePreparation()
  try {
    const { failure: _failure, ...original } = failed
    const record = { ...original, force: force ?? original.force }
    const settlement = addPendingRemoval(record)
    const job = jobFor(record)
    const leftoverOnly: BackgroundWorktreeRemovalJob = {
      ...job,
      run: async (stopSignal) => {
        // A newly registered checkout at this path needs a fresh delete, not the leftover's recorded choices.
        if (await isCheckoutRegistered(record, { signal: stopSignal })) {
          throw differentCheckoutAtPathError(record.worktreePath)
        }
        return job.run(stopSignal)
      }
    }
    runBackgroundWorktreeRemoval(record, leftoverOnly, recordWorktreeRemoval(record))
    return settlement.result
  } finally {
    release()
  }
}

export function resumeInterruptedWorktreeRemovals(
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob
): void {
  if (worktreeRemovalLifetime.closing) {
    return
  }
  for (const record of pendingWorktreeRemovals.values()) {
    if (!jobsByWorktreeId.has(record.worktreeId)) {
      runBackgroundWorktreeRemoval(record, jobFor(record), Promise.resolve())
    }
  }
}

/** Abort checkout deletes on quit without waiting for Git to exit. */
export function stopBackgroundWorktreeRemovals(): void {
  worktreeRemovalLifetime.abortCleanup()
}

function runBackgroundWorktreeRemoval(
  record: WorktreeRemovalRecord,
  job: BackgroundWorktreeRemovalJob,
  recorded: Promise<void>
): void {
  const signal = worktreeRemovalLifetime.signal
  const settled: Promise<void> = settleBackgroundWorktreeRemoval(
    record,
    settlementsByWorktreeId.get(record.worktreeId),
    job,
    recorded,
    signal
  ).finally(() => {
    if (jobsByWorktreeId.get(record.worktreeId) === settled) {
      jobsByWorktreeId.delete(record.worktreeId)
    }
  })
  jobsByWorktreeId.set(record.worktreeId, settled)
}

async function settleBackgroundWorktreeRemoval(
  record: WorktreeRemovalRecord,
  settlement: RemovalSettlement | undefined,
  job: BackgroundWorktreeRemovalJob,
  recorded: Promise<void>,
  stopSignal: AbortSignal
): Promise<void> {
  try {
    await recorded
  } catch (error) {
    const refusal = new Error(
      'Could not start deletion. The workspace is still on disk; reopen any stopped terminals and try again.',
      { cause: error }
    )
    if (pendingWorktreeRemovals.get(record.worktreeId) === record) {
      pendingWorktreeRemovals.delete(record.worktreeId)
      settlementsByWorktreeId.delete(record.worktreeId)
    }
    try {
      await job.admissionFailed?.()
    } catch (cleanupError) {
      console.warn('[worktrees] failed to release refused removal', cleanupError)
    }
    settlement?.refuse(refusal)
    settlement?.reject(refusal)
    publishSafely(job.publish)
    return
  }
  if (settlement) {
    settlement.accept()
  }
  publishSafely(job.publish)
  let settle: (settlement: RemovalSettlement) => void
  let failure: WorktreeRemovalRecord['failure']
  try {
    if (stopSignal.aborted) {
      return
    }
    const result = await job.run(stopSignal)
    finishedWorktreeRemovals.add(record)
    settle = (settlement) => settlement.resolve(result)
  } catch (error) {
    if (stopSignal.aborted) {
      // Keep the record so the next start resumes this interrupted delete.
      return
    }
    console.warn(`[worktrees] background removal of ${record.worktreePath} failed`, error)
    settle = (settlement) => settlement.reject(error)
    // Git may drop registration before file deletion fails; keep the leftover listed for an explicit retry.
    failure = await failureLeftByGit(record, error, job.cleanupPushTargetRemote)
  } finally {
    // A resumed job that ended before taking its own gate still holds the fence loading gave it.
    releaseStartupRemovalFence(record.worktreeId)
  }
  // Clear failed jobs too so their rows offer Delete again; never retry them unseen.
  const cleared = pendingWorktreeRemovals.get(record.worktreeId) === record
  if (cleared) {
    pendingWorktreeRemovals.delete(record.worktreeId)
    settlementsByWorktreeId.delete(record.worktreeId)
    if (failure) {
      failedWorktreeRemovals.set(record.worktreeId, { ...record, failure })
      // Git's catalog changed under a failed delete; cached scans still list the checkout.
      runWorktreeChangeInvalidators(record.repoId)
    }
  }
  // IPC and RPC coalesce separately; a replacement record must not strand this run's waiting request.
  if (settlement) {
    settle(settlement)
  }
  // Notify before persistence; a crash can safely resume and re-derive what remains from Git.
  publishSafely(job.publish)
  if (cleared) {
    await persistWorktreeRemovalRecords()
  }
}

function publishSafely(publish: () => void): void {
  try {
    publish()
  } catch (error) {
    console.error('[worktrees] failed to publish background removal state', error)
  }
}

export async function _settlePendingWorktreeRemovalsForTests(): Promise<void> {
  while (jobsByWorktreeId.size > 0) {
    await Promise.all(jobsByWorktreeId.values())
  }
}

export async function drainBackgroundWorktreeRemovals(): Promise<void> {
  const results = await Promise.allSettled(jobsByWorktreeId.values())
  await closeWorktreeRemovalRecords()
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Could not finish stopping workspace deletion.')
  }
}

export function _resetPendingWorktreeRemovalsForTests(): void {
  _resetWorktreeRemovalLifetimeForTests()
  pendingWorktreeRemovals.clear()
  failedWorktreeRemovals.clear()
  jobsByWorktreeId.clear()
  settlementsByWorktreeId.clear()
  for (const fence of startupFencesByWorktreeId.values()) {
    fence.release()
  }
  startupFencesByWorktreeId.clear()
  setWorktreeRemovalRecordsDirectory(null)
}
