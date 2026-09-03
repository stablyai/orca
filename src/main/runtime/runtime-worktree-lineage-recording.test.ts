import { describe, expect, it, vi } from 'vitest'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { recordCreatedWorktreeLineage } from './runtime-worktree-lineage-recording'

describe('recordCreatedWorktreeLineage orchestration ancestry', () => {
  it('persists a cross-repo spawn only as workspace lineage', () => {
    const setWorktreeLineage = vi.fn()
    const setWorkspaceLineage = vi.fn((lineage) => lineage)

    const result = recordCreatedWorktreeLineage(
      { setWorktreeLineage, setWorkspaceLineage } as never,
      { id: 'target::/child', instanceId: 'child-instance' },
      {
        kind: 'lineage',
        parent: {
          type: 'worktree',
          workspaceKey: worktreeWorkspaceKey('source::/parent'),
          worktree: { id: 'source::/parent' },
          instanceId: 'parent-instance'
        },
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'inferred' },
        orchestrationRunId: 'run_1',
        taskId: 'task_1',
        coordinatorHandle: 'term_coord',
        createdByTerminalHandle: 'term_coord'
      }
    )

    expect(setWorktreeLineage).not.toHaveBeenCalled()
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: worktreeWorkspaceKey('target::/child'),
      parentWorkspaceKey: worktreeWorkspaceKey('source::/parent'),
      origin: 'orchestration',
      taskId: 'task_1',
      orchestrationRunId: 'run_1'
    })
  })
})
