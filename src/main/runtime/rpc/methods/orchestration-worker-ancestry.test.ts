import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { assertCreatedWorkerAncestry } from './orchestration-worker-ancestry'
import type { WorkerEffect } from './orchestration-worker-topology'

const validAncestry: WorkspaceLineage = {
  childWorkspaceKey: 'worktree:target::created',
  parentWorkspaceKey: 'worktree:repo::parent',
  origin: 'orchestration' as const,
  capture: { source: 'orchestration-context' as const, confidence: 'inferred' as const },
  createdAt: 1,
  taskId: 'task_1',
  orchestrationRunId: 'run_1',
  coordinatorHandle: 'term_coord'
}

function check(workspaceLineage: typeof validAncestry | null) {
  const effects: WorkerEffect[] = []
  const recordWorkerStage = vi.fn()
  const invoke = () =>
    assertCreatedWorkerAncestry({
      db: { recordWorkerStage } as never,
      dispatchId: 'dispatch_1',
      runId: 'run_1',
      taskId: 'task_1',
      coordinatorHandle: 'term_coord',
      childWorktreeId: 'target::created',
      parentWorktreeId: 'repo::parent',
      workspaceLineage,
      effects
    })
  return { effects, invoke, recordWorkerStage }
}

describe('created worker ancestry', () => {
  it('accepts authoritative cross-repository orchestration ancestry', () => {
    const result = check(validAncestry)
    expect(result.invoke).not.toThrow()
    expect(result.effects).toEqual([])
    expect(result.recordWorkerStage).not.toHaveBeenCalled()
  })

  it('rejects absent ancestry and durably retains the created resource', () => {
    const result = check(null)
    expect(result.invoke).toThrowError(OrchestrationError)
    expect(result.effects).toEqual([
      { kind: 'worktree', action: 'created_unlinked_child', id: 'target::created' }
    ])
    expect(result.recordWorkerStage).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'dispatch_1',
        stage: 'worktree_created',
        worktreeId: 'target::created',
        residualResources: result.effects
      })
    )
  })
})
