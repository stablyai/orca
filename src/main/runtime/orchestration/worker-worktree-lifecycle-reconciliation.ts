import type { Worktree } from '../../../shared/worktree/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { completeWorkerTerminalRelease } from '../rpc/methods/orchestration-worker-release-completion'
import type { OrchestrationDb } from './db'
import {
  assertNoOtherActiveWorktreeReference,
  classifyRemovalFailure,
  errorMessage,
  findCreatedWorktreeEffect,
  findOtherActiveWorktreeReference,
  isExplicitlyRetained,
  isSelectorNotFound,
  pending,
  prContainsCurrentHead,
  retained,
  resolvePR,
  resolveWorktree,
  summarize,
  type WorkerResourceEntry,
  type WorkerWorktreeLifecycleReceipt,
  type WorkerWorktreeLifecycleReconciliationResult,
  type WorkerWorktreePRRefreshEvidence
} from './worker-worktree-lifecycle-helpers'

export type {
  WorkerWorktreeLifecycleReason,
  WorkerWorktreeLifecycleReceipt,
  WorkerWorktreeLifecycleReconciliationResult,
  WorkerWorktreePRRefreshEvidence
} from './worker-worktree-lifecycle-helpers'

type ReconciliationOptions = {
  dispatchId?: string
  worktreeId?: string
  automaticTerminalRelease?: boolean
  prEvidence?: WorkerWorktreePRRefreshEvidence
}

// Joins Orca's durable Task/Dispatch/terminal facts to exact GitHub and Git facts. This is
// intentionally a convergence pass, not an age-based collector: only Orca-created worktrees with
// a merged PR containing their current HEAD are eligible, and ordinary non-force removal remains
// the final cleanliness/branch-safety authority.
export async function reconcileWorkerWorktreeLifecycles(
  runtime: OrcaRuntimeService,
  options: ReconciliationOptions = {}
): Promise<WorkerWorktreeLifecycleReconciliationResult> {
  const db = runtime.getOrchestrationDb()
  const entries = db
    .listWorkerTerminalResources()
    .filter((entry): entry is WorkerResourceEntry => Boolean(entry.resource))
    .filter((entry) => !options.dispatchId || entry.dispatchId === options.dispatchId)
    .filter(
      (entry) =>
        !options.worktreeId ||
        entry.resource.worktree_id === options.worktreeId ||
        db.getWorkerDispatch(entry.dispatchId)?.worktree_id === options.worktreeId
    )

  const results: WorkerWorktreeLifecycleReceipt[] = []
  for (const entry of entries) {
    const created = findCreatedWorktreeEffect(db, entry.resource)
    if (!created && !options.dispatchId) {
      continue
    }
    try {
      results.push(
        await reconcileWorkerWorktreeLifecycle(runtime, db, entry, created, {
          automaticTerminalRelease: options.automaticTerminalRelease !== false,
          prEvidence: options.prEvidence
        })
      )
    } catch (error) {
      // One malformed or temporarily unavailable resource must not prevent restart recovery for
      // every other worker. Retain the failing worktree and expose the exact failure in its receipt.
      results.push({
        dispatchId: entry.dispatchId,
        taskId: entry.taskId,
        worktreeId: entry.resource.worktree_id,
        state: 'retained',
        reason: 'reconciliation_failed',
        taskReconciled: false,
        pr: null,
        branch: null,
        detail: errorMessage(error)
      })
    }
  }

  return summarize(results)
}

async function reconcileWorkerWorktreeLifecycle(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  entry: WorkerResourceEntry,
  created: { id: string } | null,
  options: {
    automaticTerminalRelease: boolean
    prEvidence?: WorkerWorktreePRRefreshEvidence
  }
): Promise<WorkerWorktreeLifecycleReceipt> {
  const base = {
    dispatchId: entry.dispatchId,
    taskId: entry.taskId,
    worktreeId: entry.resource.worktree_id,
    taskReconciled: false,
    pr: null,
    branch: null
  } satisfies Omit<WorkerWorktreeLifecycleReceipt, 'state'>

  if (!created) {
    return retained(base, 'not_orchestration_created')
  }
  if (!entry.resource.worktree_id || created.id !== entry.resource.worktree_id) {
    return retained(base, 'no_worktree_resource')
  }
  if (db.getFederatedDispatch(entry.dispatchId)) {
    return retained(base, 'terminal_release_retained', 'The worker server owns this lifecycle.')
  }

  const currentResource = db.getWorkerTerminalResource(entry.resource.id) ?? entry.resource
  if (isExplicitlyRetained(currentResource)) {
    return retained(base, 'explicitly_retained')
  }

  const task = db.getTask(entry.taskId)
  const dispatch = db.getDispatchContextById(entry.dispatchId)
  const worker = db.getWorkerDispatch(entry.dispatchId)
  if (!task || !dispatch || !worker) {
    return retained(base, 'task_not_successful', 'Task, Dispatch, or worker state is missing.')
  }
  if (
    task.status === 'failed' ||
    dispatch.status === 'failed' ||
    dispatch.status === 'circuit_broken' ||
    ['failed', 'stopped', 'abandoned'].includes(worker.state)
  ) {
    return retained(base, 'failed_or_cancelled')
  }

  const worktree = await resolveWorktree(runtime, entry.resource, base)
  if ('receipt' in worktree) {
    return worktree.receipt
  }
  if (worktree.value.isPinned) {
    return retained(base, 'pinned')
  }
  if (!worktree.value.head || !worktree.value.branch) {
    return retained(base, 'detached_or_unborn_head')
  }

  const prOutcome = await resolvePR(runtime, worktree.value, options.prEvidence)
  if (prOutcome.kind === 'upstream-error') {
    return retained(base, 'pr_lookup_failed', prOutcome.message)
  }
  if (prOutcome.kind === 'no-pr') {
    return retained(base, 'pr_not_found')
  }
  const pr = prOutcome.pr
  const withPR = { ...base, pr: { number: pr.number, url: pr.url } }
  if (pr.state !== 'merged') {
    return retained(withPR, 'pr_not_merged')
  }
  if (!prContainsCurrentHead(pr, worktree.value.head)) {
    return retained(withPR, 'worktree_head_not_merged')
  }

  let taskReconciled = false
  if (
    task.status === 'dispatched' &&
    dispatch.status === 'dispatched' &&
    worker.state === 'ready'
  ) {
    try {
      const agentStatus = await runtime.getTerminalAgentStatus(entry.resource.terminal_handle)
      if (agentStatus.isRunningAgent && agentStatus.status !== 'idle') {
        return retained(
          withPR,
          'worker_still_active',
          'The merged PR is authoritative, but the assigned worker is still active.'
        )
      }
    } catch (error) {
      const detail = errorMessage(error)
      if (!/(terminal_(?:gone|exited|not_found))|selector_not_found/i.test(detail)) {
        return retained(
          withPR,
          'worker_still_active',
          `Could not prove that the assigned worker is idle: ${detail}`
        )
      }
      // A terminal that is already gone cannot still be performing useful work. The exact merged
      // PR remains sufficient to repair the stale durable task state after a crash or reconnect.
    }
    const settlement = db.settleWorkerReport({
      taskId: entry.taskId,
      dispatchId: entry.dispatchId,
      outcome: 'succeeded',
      result: JSON.stringify({
        provenance: 'merged_pr_reconciliation',
        outcome: 'succeeded',
        pr: { number: pr.number, url: pr.url, headSha: pr.headSha ?? null },
        worktree: { id: worktree.value.id, head: worktree.value.head },
        completedAt: new Date().toISOString()
      })
    })
    if (settlement.action === 'rejected') {
      return retained(withPR, 'task_reconciliation_rejected', settlement.reason)
    }
    taskReconciled = true
  }

  const settledTask = db.getTask(entry.taskId)
  const settledDispatch = db.getDispatchContextById(entry.dispatchId)
  const settledWorker = db.getWorkerDispatch(entry.dispatchId)
  const reconciledBase = { ...withPR, taskReconciled }
  if (
    settledTask?.status !== 'completed' ||
    settledDispatch?.status !== 'completed' ||
    settledWorker?.state !== 'succeeded'
  ) {
    return retained(reconciledBase, 'task_not_successful')
  }

  let releasedResource = db.getWorkerTerminalResource(entry.resource.id) ?? entry.resource
  if (releasedResource.release_state !== 'released') {
    if (!options.automaticTerminalRelease) {
      return retained(reconciledBase, 'terminal_not_released')
    }
    const requested = db.requestWorkerTerminalRelease(entry.dispatchId, {
      respectUserRetain: true
    })
    if (requested.disposition === 'retained') {
      const reason =
        requested.reason === 'user_requested' ? 'explicitly_retained' : 'terminal_release_retained'
      return retained(reconciledBase, reason)
    }
    if (requested.disposition === 'requested') {
      const release = await completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: entry.dispatchId,
        resource: requested.resource,
        mode: 'recovery'
      })
      if (release.state === 'release_pending') {
        return pending(reconciledBase, 'terminal_release_pending', release.lastError)
      }
      if (release.state === 'release_unknown') {
        return pending(reconciledBase, 'terminal_release_unknown', release.lastError)
      }
      if (release.state === 'retained') {
        return retained(reconciledBase, 'terminal_release_retained', release.reason)
      }
    }
    releasedResource = db.getWorkerTerminalResource(entry.resource.id) ?? entry.resource
  }
  if (releasedResource.release_state !== 'released') {
    return pending(reconciledBase, 'terminal_release_pending')
  }

  const activeReference = findOtherActiveWorktreeReference(db, entry.dispatchId, worktree.value.id)
  if (activeReference) {
    return retained(
      reconciledBase,
      'active_worktree_reference',
      `Dispatch ${activeReference} still references this worktree.`
    )
  }

  // Re-read immediately before removal so a newly pinned workspace or changed HEAD cannot inherit
  // an earlier eligibility decision. removeManagedWorktree repeats the pin check inside its own
  // removal boundary and remains the authority for dirty state and safe branch deletion.
  let removalWorktree: Worktree
  try {
    removalWorktree = await runtime.showManagedWorktree(`id:${worktree.value.id}`)
  } catch (error) {
    if (isSelectorNotFound(error)) {
      return { ...reconciledBase, state: 'already_removed' }
    }
    return retained(reconciledBase, 'unsafe_to_remove', errorMessage(error))
  }
  if (removalWorktree.isPinned) {
    return retained(reconciledBase, 'pinned')
  }
  if (removalWorktree.head !== worktree.value.head) {
    return retained(
      reconciledBase,
      'worktree_head_not_merged',
      'Worktree HEAD changed after merged-PR verification.'
    )
  }

  try {
    const removed = await runtime.removeManagedWorktree(
      `id:${worktree.value.id}`,
      false,
      false,
      false,
      removalWorktree.hostId,
      true,
      true,
      removalWorktree.head,
      () => assertNoOtherActiveWorktreeReference(db, entry.dispatchId, worktree.value.id)
    )
    return {
      ...reconciledBase,
      state: 'removed',
      branch: removed.preservedBranch
        ? {
            state: 'preserved',
            name: removed.preservedBranch.branchName,
            head: removed.preservedBranch.head
          }
        : { state: 'deleted_or_absent' }
    }
  } catch (error) {
    if (isSelectorNotFound(error)) {
      return { ...reconciledBase, state: 'already_removed' }
    }
    const detail = errorMessage(error)
    return retained(reconciledBase, classifyRemovalFailure(detail), detail)
  }
}
