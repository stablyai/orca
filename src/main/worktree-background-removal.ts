import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { normalizeLocalBranchRef } from './git/worktree-operation-options'
import { acquireWatcherRemovalGate, type WatcherRemovalGate } from './ipc/watcher-removal-gate'
import { runWorktreeChangeInvalidators } from './ipc/worktree-change-invalidators'
import { parseWslPath } from './wsl'
import { readWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'
import { failureLeftByGit } from './worktree-removal-failure'
import { differentCheckoutAtPathError, isCheckoutRegistered } from './worktree-removal-leftover'
import {
  failedWorktreeRemovals,
  finishedWorktreeRemovals,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords,
  setWorktreeRemovalRecordsDirectory,
  worktreeCheckoutExists
} from './worktree-removal-table'

export type BackgroundWorktreeRemovalJob = {
  /** Abort only the checkout delete on orderly quit. */
  run: (stopSignal: AbortSignal) => Promise<RemoveWorktreeResult>
  /** Publish on acceptance and after removing the pending entry. */
  publish: () => void
  /** Clean the push-target remote even when Git partially fails. */
  cleanupPushTargetRemote?: () => Promise<void>
}

type RemovalSettlement = {
  result: Promise<RemoveWorktreeResult>
  resolve: (result: RemoveWorktreeResult) => void
  reject: (error: unknown) => void
}

const jobsByWorktreeId = new Map<string, Promise<void>>()
const settlementsByWorktreeId = new Map<string, RemovalSettlement>()
const stopControllers = new Set<AbortController>()
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
      if (hasRepo(record.repoId) && (await worktreeCheckoutExists(record.worktreePath))) {
        failedWorktreeRemovals.set(record.worktreeId, record)
      } else {
        droppedFailure = true
      }
      continue
    }
    if (!pendingWorktreeRemovals.has(record.worktreeId)) {
      addPendingRemoval(record)
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

function addPendingRemoval(record: WorktreeRemovalRecord): RemovalSettlement {
  let resolve!: RemovalSettlement['resolve']
  let reject!: RemovalSettlement['reject']
  const result = new Promise<RemoveWorktreeResult>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  // Older clients and restart-resumed jobs may have no caller to handle a rejection.
  result.catch(() => {})
  const settlement = { result, resolve, reject }
  failedWorktreeRemovals.delete(record.worktreeId)
  pendingWorktreeRemovals.set(record.worktreeId, record)
  settlementsByWorktreeId.set(record.worktreeId, settlement)
  return settlement
}

/** Pending removals are host-local; never join a same-ID checkout on another host. */
export function waitForPendingWorktreeRemoval(
  worktreeId: string,
  hostId?: ExecutionHostId,
  deleteBranch?: boolean
): Promise<RemoveWorktreeResult> | undefined {
  if ((hostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  assertAcceptedBranchChoice(pendingWorktreeRemovals.get(worktreeId), deleteBranch)
  return settlementsByWorktreeId.get(worktreeId)?.result
}

function assertAcceptedBranchChoice(
  record: WorktreeRemovalRecord | undefined,
  deleteBranch: boolean | undefined
): void {
  if (record && deleteBranch !== undefined && record.deleteBranch !== deleteBranch) {
    throw new Error(
      `Orca already accepted removal of ${record.worktreePath} with a different branch choice. That cleanup may already have run; check the branch before retrying.`
    )
  }
}

/** Await the delete while preserving the acceptance result fields. */
export async function finishAcceptedWorktreeRemoval<T extends RemoveWorktreeResult>(
  accepted: T,
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<Omit<T, 'removing'>> {
  const { removing, ...acceptance } = accepted
  const pending = removing ? waitForPendingWorktreeRemoval(worktreeId, hostId) : undefined
  return pending ? { ...acceptance, ...(await pending) } : acceptance
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
  const { worktree, ...accepted } = args.removal
  const record: WorktreeRemovalRecord = {
    ...accepted,
    worktreePath: worktree.path,
    branch: normalizeLocalBranchRef(worktree.branch),
    head: worktree.head,
    requestedAt: Date.now()
  }
  const settlement = addPendingRemoval(record)
  runBackgroundWorktreeRemoval(record, args, persistWorktreeRemovalRecords())
  publishSafely(args.publish)
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
  const failed =
    (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
      ? failedWorktreeRemovals.get(worktreeId)
      : undefined
  if (!failed) {
    return waitForPendingWorktreeRemoval(worktreeId, hostId, deleteBranch)
  }
  assertAcceptedBranchChoice(failed, deleteBranch)
  const { failure: _failure, ...original } = failed
  const record = { ...original, force: force ?? original.force }
  const settlement = addPendingRemoval(record)
  const job = jobFor(record)
  const leftoverOnly: BackgroundWorktreeRemovalJob = {
    ...job,
    run: async (stopSignal) => {
      // A newly registered checkout at this path needs a fresh delete, not the leftover's recorded choices.
      if (await isCheckoutRegistered(record)) {
        throw differentCheckoutAtPathError(record.worktreePath)
      }
      return job.run(stopSignal)
    }
  }
  runBackgroundWorktreeRemoval(record, leftoverOnly, persistWorktreeRemovalRecords())
  publishSafely(job.publish)
  return settlement.result
}

export function resumeInterruptedWorktreeRemovals(
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob
): void {
  for (const record of pendingWorktreeRemovals.values()) {
    if (!jobsByWorktreeId.has(record.worktreeId)) {
      runBackgroundWorktreeRemoval(record, jobFor(record), Promise.resolve())
    }
  }
}

/** Abort checkout deletes on quit without waiting for Git to exit. */
export function stopBackgroundWorktreeRemovals(): void {
  for (const controller of stopControllers) {
    controller.abort()
  }
}

function runBackgroundWorktreeRemoval(
  record: WorktreeRemovalRecord,
  job: BackgroundWorktreeRemovalJob,
  recorded: Promise<void>
): void {
  const controller = new AbortController()
  stopControllers.add(controller)
  const settled: Promise<void> = settleBackgroundWorktreeRemoval(
    record,
    settlementsByWorktreeId.get(record.worktreeId),
    job,
    recorded,
    controller.signal
  ).finally(() => {
    stopControllers.delete(controller)
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
  await waitForRecordWrite(record, recorded)
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

// Prefer a durable resume record, but do not hold deletion indefinitely on stalled disk writes.
const RECORD_WRITE_WAIT_MS = 2_000

async function waitForRecordWrite(
  record: WorktreeRemovalRecord,
  recorded: Promise<void>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    recorded.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), RECORD_WRITE_WAIT_MS)
    })
  ])
  clearTimeout(timer)
  if (timedOut) {
    console.warn(
      `[worktrees] removal record for ${record.worktreePath} not on disk after ${RECORD_WRITE_WAIT_MS} ms; deleting anyway`
    )
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

export function _resetPendingWorktreeRemovalsForTests(): void {
  pendingWorktreeRemovals.clear()
  failedWorktreeRemovals.clear()
  jobsByWorktreeId.clear()
  settlementsByWorktreeId.clear()
  stopControllers.clear()
  for (const fence of startupFencesByWorktreeId.values()) {
    fence.release()
  }
  startupFencesByWorktreeId.clear()
  setWorktreeRemovalRecordsDirectory(null)
}
