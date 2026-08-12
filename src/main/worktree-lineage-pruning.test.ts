import { describe, expect, it, vi } from 'vitest'
import type { Repo, WorktreeLineage, WorkspaceLineage, WorktreeMeta } from '../shared/types'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { pruneLineageForMissingRepoWorktrees } from './worktree-lineage-pruning'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

function lineage(childId: string, parentId: string): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function workspaceLineage(childId: string, parentId: string): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(childId),
    childInstanceId: `${childId}-instance`,
    parentWorkspaceKey: worktreeWorkspaceKey(parentId),
    parentInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function createStore(
  worktreeLineageById: Record<string, WorktreeLineage>,
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>,
  metaById: Record<string, WorktreeMeta>
) {
  return {
    getRepos: () => [repo],
    getAllWorktreeLineage: () => worktreeLineageById,
    getAllWorkspaceLineage: () => workspaceLineageByChildKey,
    getWorktreeMeta: (id: string) => metaById[id],
    removeWorktreeLineage: vi.fn((id: string) => delete worktreeLineageById[id]),
    removeWorkspaceLineage: vi.fn((key: string) => delete workspaceLineageByChildKey[key]),
    setWorktreeMeta: vi.fn((id: string, updates: Partial<WorktreeMeta>) => {
      metaById[id] = { ...metaById[id], ...updates }
      return metaById[id]
    })
  }
}

describe('pruneLineageForMissingRepoWorktrees', () => {
  it('refuses an empty scan when the repo still has registered lineage', () => {
    const parentId = 'repo-1::/repo/parent'
    const childId = 'repo-1::/repo/child'
    const edge = lineage(childId, parentId)
    const workspaceEdge = workspaceLineage(childId, parentId)
    const worktreeLineageById = { [childId]: edge }
    const workspaceLineageByChildKey = { [worktreeWorkspaceKey(childId)]: workspaceEdge }
    const metaById = {
      [parentId]: { instanceId: edge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(worktreeLineageById, workspaceLineageByChildKey, metaById)

    pruneLineageForMissingRepoWorktrees(store as never, repo, [])

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.removeWorkspaceLineage).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(worktreeLineageById[childId]).toBe(edge)
    expect(workspaceLineageByChildKey[worktreeWorkspaceKey(childId)]).toBe(workspaceEdge)
  })

  it('prunes missing children and rotates missing parents after a trusted non-empty scan', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const missingChildId = 'repo-1::/repo/missing-child'
    const liveChildId = 'repo-1::/repo/live-child'
    const missingParentId = 'repo-1::/repo/missing-parent'
    const missingChildEdge = lineage(missingChildId, liveParentId)
    const missingParentEdge = lineage(liveChildId, missingParentId)
    const worktreeLineageById = {
      [missingChildId]: missingChildEdge,
      [liveChildId]: missingParentEdge
    }
    const workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(missingChildId)]: workspaceLineage(missingChildId, liveParentId),
      [worktreeWorkspaceKey(liveChildId)]: workspaceLineage(liveChildId, missingParentId)
    }
    const metaById = {
      [liveParentId]: { instanceId: missingChildEdge.parentWorktreeInstanceId } as WorktreeMeta,
      [missingParentId]: { instanceId: missingParentEdge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(worktreeLineageById, workspaceLineageByChildKey, metaById)

    pruneLineageForMissingRepoWorktrees(store as never, repo, [
      {
        path: '/repo/live-parent',
        head: 'a',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/repo/live-child',
        head: 'b',
        branch: 'child',
        isBare: false,
        isMainWorktree: false
      }
    ])

    expect(store.removeWorktreeLineage).toHaveBeenCalledWith(missingChildId)
    expect(store.removeWorktreeLineage).not.toHaveBeenCalledWith(liveChildId)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(missingParentId, {
      instanceId: expect.any(String)
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalledWith(liveParentId, expect.anything())
    expect(metaById[missingParentId].instanceId).not.toBe(
      missingParentEdge.parentWorktreeInstanceId
    )
  })
})
