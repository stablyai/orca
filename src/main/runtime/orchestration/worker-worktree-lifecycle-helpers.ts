import type { PRRefreshOutcome } from '../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

const CREATED_WORKTREE_ACTIONS = new Set(['created_child', 'created_top_level'])
const ACTIVE_TASK_STATES = new Set(['pending', 'ready', 'dispatched', 'blocked'])
const ACTIVE_DISPATCH_STATES = new Set(['pending', 'dispatched'])
const ACTIVE_WORKER_STATES = new Set([
  'starting',
  'ready',
  'start_unknown',
  'stopping',
  'stop_unknown'
])

export type WorkerWorktreeLifecycleReason =
  | 'not_orchestration_created'
  | 'no_worktree_resource'
  | 'explicitly_retained'
  | 'pinned'
  | 'failed_or_cancelled'
  | 'task_not_successful'
  | 'worktree_not_found'
  | 'detached_or_unborn_head'
  | 'pr_not_found'
  | 'pr_not_merged'
  | 'pr_lookup_failed'
  | 'worktree_head_not_merged'
  | 'task_reconciliation_rejected'
  | 'worker_still_active'
  | 'terminal_release_retained'
  | 'terminal_release_pending'
  | 'terminal_release_unknown'
  | 'terminal_not_released'
  | 'active_worktree_reference'
  | 'active_terminal_reference'
  | 'reconciliation_failed'
  | 'unsafe_to_remove'

export type WorkerWorktreeLifecycleReceipt = {
  dispatchId: string
  taskId: string
  worktreeId: string | null
  state: 'removed' | 'already_removed' | 'retained' | 'release_pending'
  reason?: WorkerWorktreeLifecycleReason
  taskReconciled: boolean
  pr: { number: number; url: string } | null
  branch: { state: 'deleted_or_absent' | 'preserved'; name?: string; head?: string } | null
  detail?: string
}

export type WorkerWorktreeLifecycleReconciliationResult = {
  attempted: number
  removed: number
  alreadyRemoved: number
  retained: number
  releasePending: number
  results: WorkerWorktreeLifecycleReceipt[]
}

export type WorkerWorktreePRRefreshEvidence = {
  worktreeId: string
  currentHeadOid: string | null
  outcome: PRRefreshOutcome
}

export type WorkerResourceEntry = ReturnType<
  OrchestrationDb['listWorkerTerminalResources']
>[number] & {
  resource: WorkerTerminalResourceRow
}

export async function resolveWorktree(
  runtime: OrcaRuntimeService,
  resource: WorkerTerminalResourceRow,
  base: Omit<WorkerWorktreeLifecycleReceipt, 'state'>
): Promise<{ value: Worktree } | { receipt: WorkerWorktreeLifecycleReceipt }> {
  try {
    return { value: await runtime.showManagedWorktree(`id:${resource.worktree_id}`) }
  } catch (error) {
    if (isSelectorNotFound(error) && resource.release_state === 'released') {
      return { receipt: { ...base, state: 'already_removed' } }
    }
    return {
      receipt: retained(
        base,
        'worktree_not_found',
        isSelectorNotFound(error) ? undefined : errorMessage(error)
      )
    }
  }
}

export async function resolvePR(
  runtime: OrcaRuntimeService,
  worktree: Worktree,
  evidence?: WorkerWorktreePRRefreshEvidence
): Promise<PRRefreshOutcome> {
  if (
    evidence?.worktreeId === worktree.id &&
    normalizeOid(evidence.currentHeadOid) === normalizeOid(worktree.head)
  ) {
    return evidence.outcome
  }
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  return runtime.getRepoPRForBranch(
    worktree.repoId,
    branch,
    worktree.linkedPR,
    worktree.linkedPR,
    true,
    worktree.head
  )
}

export function prContainsCurrentHead(pr: PRInfo, head: string): boolean {
  const normalizedHead = normalizeOid(head)
  return Boolean(
    normalizedHead &&
    (normalizeOid(pr.headSha) === normalizedHead ||
      normalizeOid(pr.confirmedContainedHeadOid) === normalizedHead)
  )
}

export function findCreatedWorktreeEffect(
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): { id: string } | null {
  const originWorker = db.getWorkerDispatch(resource.origin_dispatch_id)
  if (!originWorker) {
    return null
  }
  try {
    const effects = JSON.parse(originWorker.effects) as unknown
    if (!Array.isArray(effects)) {
      return null
    }
    const effect = effects.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        (candidate as { kind?: unknown }).kind === 'worktree' &&
        CREATED_WORKTREE_ACTIONS.has(String((candidate as { action?: unknown }).action)) &&
        typeof (candidate as { id?: unknown }).id === 'string'
    ) as { id?: string } | undefined
    return effect?.id ? { id: effect.id } : null
  } catch {
    return null
  }
}

export function findOtherActiveWorktreeReference(
  db: OrchestrationDb,
  dispatchId: string,
  worktreeId: string
): string | null {
  for (const candidate of db.listWorkerTerminalResources()) {
    if (candidate.dispatchId === dispatchId) {
      continue
    }
    const worker = db.getWorkerDispatch(candidate.dispatchId)
    if (worker?.worktree_id !== worktreeId) {
      continue
    }
    const task = db.getTask(candidate.taskId)
    const dispatch = db.getDispatchContextById(candidate.dispatchId)
    if (
      (task && ACTIVE_TASK_STATES.has(task.status)) ||
      (dispatch && ACTIVE_DISPATCH_STATES.has(dispatch.status)) ||
      ACTIVE_WORKER_STATES.has(worker.state)
    ) {
      return candidate.dispatchId
    }
  }
  return null
}

export function assertNoOtherActiveWorktreeReference(
  db: OrchestrationDb,
  dispatchId: string,
  worktreeId: string
): void {
  const activeDispatchId = findOtherActiveWorktreeReference(db, dispatchId, worktreeId)
  if (activeDispatchId) {
    throw new Error(
      `Cannot automatically delete worktree ${worktreeId} while active Dispatch ${activeDispatchId} still references it.`
    )
  }
}

export function classifyRemovalFailure(detail: string): WorkerWorktreeLifecycleReason {
  if (detail.includes('while it has active terminals')) {
    return 'active_terminal_reference'
  }
  if (detail.includes('while active Dispatch')) {
    return 'active_worktree_reference'
  }
  return 'unsafe_to_remove'
}

export function isExplicitlyRetained(resource: WorkerTerminalResourceRow): boolean {
  return (
    resource.release_state === 'retained' ||
    resource.ownership_state === 'user_owned' ||
    resource.ownership_state === 'transferred' ||
    resource.ownership_state === 'external'
  )
}

export function retained(
  base: Omit<WorkerWorktreeLifecycleReceipt, 'state'>,
  reason: WorkerWorktreeLifecycleReason,
  detail?: unknown
): WorkerWorktreeLifecycleReceipt {
  return {
    ...base,
    state: 'retained',
    reason,
    ...(detail === undefined ? {} : { detail: String(detail) })
  }
}

export function pending(
  base: Omit<WorkerWorktreeLifecycleReceipt, 'state'>,
  reason: WorkerWorktreeLifecycleReason,
  detail?: string
): WorkerWorktreeLifecycleReceipt {
  return {
    ...base,
    state: 'release_pending',
    reason,
    ...(detail ? { detail } : {})
  }
}

export function summarize(
  results: WorkerWorktreeLifecycleReceipt[]
): WorkerWorktreeLifecycleReconciliationResult {
  return {
    attempted: results.length,
    removed: results.filter((result) => result.state === 'removed').length,
    alreadyRemoved: results.filter((result) => result.state === 'already_removed').length,
    retained: results.filter((result) => result.state === 'retained').length,
    releasePending: results.filter((result) => result.state === 'release_pending').length,
    results
  }
}

function normalizeOid(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

export function isSelectorNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'selector_not_found'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
