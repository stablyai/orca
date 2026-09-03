import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerEffect } from './orchestration-worker-topology'

/** Fail closed when a newly created child cannot prove its requested orchestration ancestry. */
export function assertCreatedWorkerAncestry(args: {
  db: OrchestrationDb
  dispatchId: string
  runId: string
  taskId: string
  coordinatorHandle: string
  childWorktreeId: string
  parentWorktreeId: string
  workspaceLineage?: WorkspaceLineage | null
  effects: WorkerEffect[]
}): void {
  const ancestry = args.workspaceLineage
  if (
    ancestry?.origin === 'orchestration' &&
    ancestry.childWorkspaceKey === worktreeWorkspaceKey(args.childWorktreeId) &&
    ancestry.parentWorkspaceKey === worktreeWorkspaceKey(args.parentWorktreeId) &&
    ancestry.taskId === args.taskId &&
    ancestry.orchestrationRunId === args.runId &&
    ancestry.coordinatorHandle === args.coordinatorHandle
  ) {
    return
  }
  args.effects.push({
    kind: 'worktree',
    action: 'created_unlinked_child',
    id: args.childWorktreeId
  })
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'worktree_created',
    worktreeId: args.childWorktreeId,
    effects: args.effects,
    residualResources: args.effects
  })
  throw new OrchestrationError(
    'created_unlinked_child',
    'Created child worktree is missing authoritative orchestration ancestry.'
  )
}
