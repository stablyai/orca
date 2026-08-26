import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { pruneLineageForMissingRepoWorktrees } from './worktree-lineage-pruning'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

function lineage(childId: string, parentId: string, createdAt = 1): WorktreeLineage {
  return {
    worktreeId: childId,
    worktreeInstanceId: `${childId}-instance`,
    parentWorktreeId: parentId,
    parentWorktreeInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt
  }
}

function workspaceLineage(childId: string, parentId: string, createdAt = 1): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(childId),
    childInstanceId: `${childId}-instance`,
    parentWorkspaceKey: worktreeWorkspaceKey(parentId),
    parentInstanceId: `${parentId}-instance`,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt
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

  it('keeps lineage registered after the scan started, then prunes it once a later scan misses it', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const newChildId = 'repo-1::/repo/new-child'
    const scanStartedAt = 1_000
    const newChildEdge = lineage(newChildId, liveParentId, scanStartedAt + 1)
    const worktreeLineageById = { [newChildId]: newChildEdge }
    const workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(newChildId)]: workspaceLineage(
        newChildId,
        liveParentId,
        scanStartedAt + 1
      )
    }
    const metaById = {
      [liveParentId]: { instanceId: newChildEdge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(worktreeLineageById, workspaceLineageByChildKey, metaById)
    const staleScan = [
      {
        path: '/repo/live-parent',
        head: 'a',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
    ]

    pruneLineageForMissingRepoWorktrees(store as never, repo, staleScan, scanStartedAt)

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.removeWorkspaceLineage).not.toHaveBeenCalled()
    expect(worktreeLineageById[newChildId]).toBe(newChildEdge)

    pruneLineageForMissingRepoWorktrees(store as never, repo, staleScan, scanStartedAt + 2)

    expect(store.removeWorktreeLineage).toHaveBeenCalledWith(newChildId)
    expect(worktreeLineageById[newChildId]).toBeUndefined()
  })

  it('leaves a mid-scan parent identity alone instead of rotating it', () => {
    const newParentId = 'repo-1::/repo/new-parent'
    const newChildId = 'repo-1::/repo/new-child'
    const scanStartedAt = 1_000
    const newEdge = lineage(newChildId, newParentId, scanStartedAt + 1)
    const worktreeLineageById = { [newChildId]: newEdge }
    const metaById = {
      [newParentId]: { instanceId: newEdge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(worktreeLineageById, {}, metaById)

    pruneLineageForMissingRepoWorktrees(
      store as never,
      repo,
      [
        {
          path: '/repo/unrelated',
          head: 'a',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ],
      scanStartedAt
    )

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(metaById[newParentId].instanceId).toBe(newEdge.parentWorktreeInstanceId)
  })

  it('prunes on a trusted scan when no scan start time is supplied', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const missingChildId = 'repo-1::/repo/missing-child'
    const edge = lineage(missingChildId, liveParentId, Number.MAX_SAFE_INTEGER)
    const worktreeLineageById = { [missingChildId]: edge }
    const metaById = {
      [liveParentId]: { instanceId: edge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(worktreeLineageById, {}, metaById)

    pruneLineageForMissingRepoWorktrees(store as never, repo, [
      {
        path: '/repo/live-parent',
        head: 'a',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
    ])

    expect(store.removeWorktreeLineage).toHaveBeenCalledWith(missingChildId)
  })
})
