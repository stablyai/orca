import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { normalizeLocalBranchRef } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { acquireWatcherRemovalGate, type WatcherRemovalGate } from './ipc/watcher-removal-gate'
import { parseWslPath } from './wsl'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords,
  type WorktreeRemovalRecord
} from './worktree-removal-records'

export type BackgroundWorktreeRemovalJob = {
  /** `stopSignal` aborts on an orderly quit; pass it only to the checkout delete. */
  run: (stopSignal: AbortSignal) => Promise<RemoveWorktreeResult>
  /** Fires when the row starts showing as removing, and again after it has left the table. */
  publish: () => void
}

/** The removals pending when a listing began to read Git. */
export type PendingWorktreeRemovals = ReadonlyMap<string, WorktreeRemovalRecord>

type RemovalSettlement = {
  result: Promise<RemoveWorktreeResult>
  resolve: (result: RemoveWorktreeResult) => void
  reject: (error: unknown) => void
}

// The accepted removals, mirrored to disk on every change; listings and joins read only this.
const pendingByWorktreeId = new Map<string, WorktreeRemovalRecord>()
const jobsByWorktreeId = new Map<string, Promise<void>>()
// What every request for a pending removal waits on: the first one and any that join it.
const settlementsByWorktreeId = new Map<string, RemovalSettlement>()
const stopControllers = new Set<AbortController>()
// Loaded removals' terminal/watcher fences, held until the resumed job takes its own gate.
const startupFencesByWorktreeId = new Map<string, WatcherRemovalGate>()
// Why weak: a listing that read Git before a delete finished holds the record until it replies.
const removedRecords = new WeakSet<WorktreeRemovalRecord>()
const NO_PENDING_REMOVALS: PendingWorktreeRemovals = new Map()
let recordsDirectory: string | null = null

/**
 * Loads removals a quit or crash interrupted, so listings mark them before the first paint and
 * session restore cannot open a terminal or watcher in a half-deleted checkout before the resume.
 */
export async function loadWorktreeRemovalRecords(directory: string): Promise<void> {
  recordsDirectory = directory
  for (const record of await readWorktreeRemovalRecords(directory)) {
    if (!pendingByWorktreeId.has(record.worktreeId)) {
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
  pendingByWorktreeId.set(record.worktreeId, record)
  settlementsByWorktreeId.set(record.worktreeId, settlement)
  return settlement
}

function persistRecords(): Promise<void> {
  if (!recordsDirectory) {
    return Promise.resolve()
  }
  return writeWorktreeRemovalRecords(recordsDirectory, () => [
    ...pendingByWorktreeId.values()
  ]).catch((error: unknown) => {
    // Why: bookkeeping must not gate the delete; a lost write only costs resuming it after a quit.
    console.warn('[worktrees] failed to persist worktree removal records', error)
  })
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

export function hasPendingWorktreeRemovals(): boolean {
  return pendingByWorktreeId.size > 0
}

/** Whether an accepted or interrupted local removal still owns this path, in any repo. */
export function isWorktreeRemovalPendingAt(worktreePath: string): boolean {
  return [...pendingByWorktreeId.values()].some((removal) =>
    areWorktreePathsEqual(removal.worktreePath, worktreePath)
  )
}

export function findPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): WorktreeRemovalRecord | undefined {
  const branch = target.branch?.replace(/^refs\/heads\//, '')
  for (const removal of pendingByWorktreeId.values()) {
    if (!areWorktreePathsEqual(removal.repoPath, repoPath)) {
      continue
    }
    if (
      (target.worktreePath && areWorktreePathsEqual(removal.worktreePath, target.worktreePath)) ||
      (branch && removal.branch === branch)
    ) {
      return removal
    }
  }
  return undefined
}

export function assertNoPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): void {
  const removal = findPendingWorktreeRemovalConflict(repoPath, target)
  if (removal) {
    throw new Error(
      `Orca is still deleting the workspace at ${removal.worktreePath}. Cleanup is pending; try again shortly.`
    )
  }
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
  runBackgroundWorktreeRemoval(record, args, persistRecords())
  publishSafely(args.publish)
  return settlement.result
}

/** Runs the same delete again for every record a quit or crash left without a running job. */
export function resumeInterruptedWorktreeRemovals(
  jobFor: (record: WorktreeRemovalRecord) => BackgroundWorktreeRemovalJob
): void {
  for (const record of pendingByWorktreeId.values()) {
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
  try {
    if (stopSignal.aborted) {
      return
    }
    const result = await job.run(stopSignal)
    removedRecords.add(record)
    settle = (settlement) => settlement.resolve(result)
  } catch (error) {
    if (stopSignal.aborted) {
      // Why: quit stopped Git; the record stays so the next start finishes this delete.
      return
    }
    console.warn(`[worktrees] background removal of ${record.worktreePath} failed`, error)
    settle = (settlement) => settlement.reject(error)
  } finally {
    // A resumed job that ended before taking its own gate still holds the fence loading gave it.
    releaseStartupRemovalFence(record.worktreeId)
  }
  // Why clear on failure too: the row returns live and retryable instead of retrying unseen.
  const cleared = pendingByWorktreeId.get(record.worktreeId) === record
  if (cleared) {
    pendingByWorktreeId.delete(record.worktreeId)
    settlementsByWorktreeId.delete(record.worktreeId)
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
    await persistRecords()
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

/** Taken before a listing reads Git; pass it to projectPendingWorktreeRemovals with the rows. */
export function snapshotPendingWorktreeRemovals(): PendingWorktreeRemovals {
  return pendingByWorktreeId.size === 0 ? NO_PENDING_REMOVALS : new Map(pendingByWorktreeId)
}

/**
 * Marks rows whose checkout this host is deleting, or leaves them out for a client that cannot
 * read the marker: such a client already dropped the row on acceptance and would re-show it.
 */
export function projectPendingWorktreeRemovals<
  T extends { hostId?: ExecutionHostId; removing?: true }
>(
  rows: T[],
  idOf: (row: T) => string,
  clientReadsMarker: boolean,
  pendingAtScan: PendingWorktreeRemovals
): T[] {
  if (pendingByWorktreeId.size === 0 && pendingAtScan.size === 0) {
    return rows
  }
  const projected: T[] = []
  for (const row of rows) {
    const id = idOf(row)
    const local = row.hostId === undefined || row.hostId === LOCAL_EXECUTION_HOST_ID
    if (local && pendingByWorktreeId.has(id)) {
      if (clientReadsMarker) {
        projected.push({ ...row, removing: true })
      }
      continue
    }
    const scanned = local ? pendingAtScan.get(id) : undefined
    // Why: Git was read before this delete finished; unmarked, the gone row reads as a failed delete.
    if (!scanned || !removedRecords.has(scanned)) {
      projected.push(row)
    }
  }
  return projected
}

export async function _settlePendingWorktreeRemovalsForTests(): Promise<void> {
  while (jobsByWorktreeId.size > 0) {
    await Promise.all(jobsByWorktreeId.values())
  }
}

export function _resetPendingWorktreeRemovalsForTests(): void {
  pendingByWorktreeId.clear()
  jobsByWorktreeId.clear()
  settlementsByWorktreeId.clear()
  stopControllers.clear()
  for (const fence of startupFencesByWorktreeId.values()) {
    fence.release()
  }
  startupFencesByWorktreeId.clear()
  recordsDirectory = null
}
