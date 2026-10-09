import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { normalizeLocalBranchRef } from './git/worktree-operation-options'
import { acquireWatcherRemovalGate, type WatcherRemovalGate } from './ipc/watcher-removal-gate'
import { runWorktreeChangeInvalidators } from './ipc/worktree-change-invalidators'
import { parseWslPath } from './wsl'
import { readWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'
import {
  DifferentCheckoutAtPathError,
  differentCheckoutAtPathError,
  isCheckoutRegistered,
  isUnregisteredRemovalLeftover
} from './worktree-removal-leftover'
import {
  failedWorktreeRemovals,
  finishedWorktreeRemovals,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords,
  setWorktreeRemovalRecordsDirectory,
  worktreeCheckoutExists
} from './worktree-removal-table'

export type BackgroundWorktreeRemovalJob = {
  /** `stopSignal` aborts on an orderly quit; pass it only to the checkout delete. */
  run: (stopSignal: AbortSignal) => Promise<RemoveWorktreeResult>
  /** Fires when the row starts showing as removing, and again after it has left the table. */
  publish: () => void
}

type RemovalSettlement = {
  result: Promise<RemoveWorktreeResult>
  resolve: (result: RemoveWorktreeResult) => void
  reject: (error: unknown) => void
}

const jobsByWorktreeId = new Map<string, Promise<void>>()
// What every request for a pending removal waits on: the first one and any that join it.
const settlementsByWorktreeId = new Map<string, RemovalSettlement>()
const stopControllers = new Set<AbortController>()
// Loaded removals' terminal/watcher fences, held until the resumed job takes its own gate.
const startupFencesByWorktreeId = new Map<string, WatcherRemovalGate>()

/**
 * Loads removals a quit or crash interrupted, so listings mark them before the first paint and
 * session restore cannot open a terminal or watcher in a half-deleted checkout before the resume.
 */
export async function loadWorktreeRemovalRecords(
  directory: string,
  hasRepo: (repoId: string) => boolean = () => true
): Promise<void> {
  setWorktreeRemovalRecordsDirectory(directory)
  let droppedFailure = false
  for (const record of await readWorktreeRemovalRecords(directory)) {
    if (record.failure) {
      // Why the repo: only its listing shows the row, so nothing else could end a removed repo's.
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

/** Hands a loaded removal's fence to its resumed job; call in the same tick the job takes its gate. */
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
  // Why: a removal nobody waits on (an older client's, or one a restart resumed) may still fail.
  result.catch(() => {})
  const settlement = { result, resolve, reject }
  // A new removal of the same workspace supersedes its failed one.
  failedWorktreeRemovals.delete(record.worktreeId)
  pendingWorktreeRemovals.set(record.worktreeId, record)
  settlementsByWorktreeId.set(record.worktreeId, settlement)
  return settlement
}

/**
 * The result of the removal this host is running for the worktree, for a request that joins it.
 * Only this host's local checkouts are removed in the background.
 */
export function waitForPendingWorktreeRemoval(
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<RemoveWorktreeResult> | undefined {
  return (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
    ? settlementsByWorktreeId.get(worktreeId)?.result
    : undefined
}

/** Waits for the delete an accepted background removal started; the acceptance's fields ride along. */
export async function finishAcceptedWorktreeRemoval<T extends RemoveWorktreeResult>(
  accepted: T,
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<Omit<T, 'removing'>> {
  const { removing, ...acceptance } = accepted
  const pending = removing ? waitForPendingWorktreeRemoval(worktreeId, hostId) : undefined
  return pending ? { ...acceptance, ...(await pending) } : acceptance
}

/** WSL checkouts still delete inline, as before; moving them off the request is a follow-up. */
export function removesInBackground(
  worktreePath: string,
  options: { wslDistro?: string }
): boolean {
  return !options.wslDistro && !parseWslPath(worktreePath)
}

/**
 * Records an accepted removal and runs its delete detached from the request that asked for it, so
 * the delete finishes even when that request times out or its client goes away. Resolves with the
 * delete's result.
 */
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

/**
 * Delete on a failed delete's leftover that Git's current listing still does not register: runs the
 * recorded removal again, with the choices the user made the first time, or joins the one another
 * request started while this one listed Git. Undefined when neither.
 */
export function retryFailedWorktreeRemoval(
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob
): Promise<RemoveWorktreeResult> | undefined {
  const failed =
    (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
      ? failedWorktreeRemovals.get(worktreeId)
      : undefined
  if (!failed) {
    return waitForPendingWorktreeRemoval(worktreeId, hostId)
  }
  const { failure: _failure, ...record } = failed
  const settlement = addPendingRemoval(record)
  const job = jobFor(record)
  const leftoverOnly: BackgroundWorktreeRemovalJob = {
    ...job,
    run: async (stopSignal) => {
      // Why: the recorded choices (force, branch) were for the leftover; a checkout Git registered
      // at the path after the caller listed is a new one, which only the normal delete may remove.
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

/** Runs the same delete again for every record a quit or crash left without a running job. */
export function resumeInterruptedWorktreeRemovals(
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob
): void {
  for (const record of pendingWorktreeRemovals.values()) {
    if (!jobsByWorktreeId.has(record.worktreeId)) {
      runBackgroundWorktreeRemoval(record, jobFor(record), Promise.resolve())
    }
  }
}

/** Orderly quit: stops each checkout delete Git is running, without waiting for it to exit. */
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
      // Why: quit stopped Git; the record stays so the next start finishes this delete.
      return
    }
    console.warn(`[worktrees] background removal of ${record.worktreePath} failed`, error)
    settle = (settlement) => settlement.reject(error)
    // Why: Git drops the registration even when it fails to delete the checkout, and Orca lists
    // workspaces from Git, so without the record the leftover would vanish with no way to retry.
    // A refusal that keeps the registration is recorded too, so a caller polling the outcome
    // gets Git's reason; Git still lists that checkout, and the next Delete drops the record.
    if (await isCheckoutLeftBehind(record, error)) {
      failure = {
        message: error instanceof Error ? error.message : String(error),
        failedAt: Date.now()
      }
    }
  } finally {
    // A resumed job that ended before taking its own gate still holds the fence loading gave it.
    releaseStartupRemovalFence(record.worktreeId)
  }
  // Why clear on failure too: the row returns with its error and Delete retries it; nothing
  // retries unseen.
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
  // Why this run's own settlement: desktop IPC and runtime RPC coalesce separately, so a concurrent
  // removal can replace the record, and the request waiting on this delete must still get its reply.
  if (settlement) {
    settle(settlement)
  }
  // Why notify before the clear is on disk: the clear is bookkeeping; a crash before it lands only
  // re-runs a finish that re-derives what is left from Git.
  publishSafely(job.publish)
  if (cleared) {
    await persistWorktreeRemovalRecords()
  }
}

async function isCheckoutLeftBehind(
  record: WorktreeRemovalRecord,
  error: unknown
): Promise<boolean> {
  if (!(await worktreeCheckoutExists(record.worktreePath))) {
    return false
  }
  try {
    if (await isCheckoutRegistered(record)) {
      // A retry that found a newer checkout at the path refused that one, not this removal's.
      return !(error instanceof DifferentCheckoutAtPathError)
    }
    return await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath)
  } catch (listError) {
    // Unknowable: the row stays however Git lists it, as before this record existed.
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, listError)
    return false
  }
}

// Why: the record should be on disk before Git deletes, so a quit resumes the delete, but a disk or
// file pool stall must not hold the user's delete; past this, a crash only loses the resume.
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
    // Why: a failed notification must not strand the table entry or reject the detached job.
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
