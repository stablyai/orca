import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import { pendingWorktreeRemovals } from './worktree-removal-table'

export type RemovalSettlement = {
  accepted: Promise<void>
  accept: () => void
  refuse: (error: unknown) => void
  result: Promise<RemoveWorktreeResult>
  resolve: (result: RemoveWorktreeResult) => void
  reject: (error: unknown) => void
}

export const settlementsByWorktreeId = new Map<string, RemovalSettlement>()

export function addPendingRemoval(record: WorktreeRemovalRecord): RemovalSettlement {
  let accept!: RemovalSettlement['accept']
  let refuse!: RemovalSettlement['refuse']
  const accepted = new Promise<void>((resolve, reject) => {
    accept = resolve
    refuse = reject
  })
  accepted.catch(() => {})
  let resolve!: RemovalSettlement['resolve']
  let reject!: RemovalSettlement['reject']
  const result = new Promise<RemoveWorktreeResult>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  // Older clients and restart-resumed jobs may have no caller to handle a rejection.
  result.catch(() => {})
  const settlement = { accepted, accept, refuse, result, resolve, reject }
  pendingWorktreeRemovals.set(record.worktreeId, record)
  settlementsByWorktreeId.set(record.worktreeId, settlement)
  return settlement
}

/** Acceptance is separate from completion so CLI outcomes can keep waiting for Git. */
export function waitForWorktreeRemovalAcceptance(
  worktreeId: string,
  hostId?: ExecutionHostId
): Promise<void> | undefined {
  return (hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
    ? settlementsByWorktreeId.get(worktreeId)?.accepted
    : undefined
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
