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

const SCAN_LINEAGE_REVISION = 7

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
  metaById: Record<string, WorktreeMeta>,
  lineageRevision = SCAN_LINEAGE_REVISION
) {
  return {
    getRepos: () => [repo],
    getLineageRevision: vi.fn(() => lineageRevision),
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

    pruneLineageForMissingRepoWorktrees(store as never, repo, [], SCAN_LINEAGE_REVISION)

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

    pruneLineageForMissingRepoWorktrees(
      store as never,
      repo,
      [
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
      ],
      SCAN_LINEAGE_REVISION
    )

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

  it('fails closed when a causally newer write lands after scan capture', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const justCreatedId = 'repo-1::/repo/just-created'
    const longGoneId = 'repo-1::/repo/long-gone'
    const justCreatedEdge = { ...lineage(justCreatedId, liveParentId), createdAt: -10_000 }
    const longGoneEdge = { ...lineage(longGoneId, liveParentId), createdAt: 1 }
    const worktreeLineageById = {
      [justCreatedId]: justCreatedEdge,
      [longGoneId]: longGoneEdge
    }
    const workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(justCreatedId)]: {
        ...workspaceLineage(justCreatedId, liveParentId),
        createdAt: -10_000
      },
      [worktreeWorkspaceKey(longGoneId)]: {
        ...workspaceLineage(longGoneId, liveParentId),
        createdAt: 1
      }
    }
    const metaById = {
      [liveParentId]: { instanceId: justCreatedEdge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(
      worktreeLineageById,
      workspaceLineageByChildKey,
      metaById,
      SCAN_LINEAGE_REVISION + 1
    )

    pruneLineageForMissingRepoWorktrees(
      store as never,
      repo,
      [
        {
          path: '/repo/live-parent',
          head: 'a',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ],
      SCAN_LINEAGE_REVISION
    )

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.removeWorkspaceLineage).not.toHaveBeenCalled()
  })

  it('prunes causally old lineage despite a forward-skewed wall clock', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const childId = 'repo-1::/repo/forward-skewed-child'
    const edge = { ...lineage(childId, liveParentId), createdAt: Number.MAX_SAFE_INTEGER }
    const worktreeLineageById = { [childId]: edge }
    const workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(childId)]: {
        ...workspaceLineage(childId, liveParentId),
        createdAt: Number.MAX_SAFE_INTEGER
      }
    }
    const store = createStore(worktreeLineageById, workspaceLineageByChildKey, {
      [liveParentId]: { instanceId: edge.parentWorktreeInstanceId } as WorktreeMeta
    })

    pruneLineageForMissingRepoWorktrees(
      store as never,
      repo,
      [
        {
          path: '/repo/live-parent',
          head: 'a',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ],
      SCAN_LINEAGE_REVISION
    )

    expect(store.removeWorktreeLineage).toHaveBeenCalledWith(childId)
    expect(store.removeWorkspaceLineage).toHaveBeenCalledWith(worktreeWorkspaceKey(childId))
  })

  it('fails closed when the store cannot report causal lineage authority', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const childId = 'repo-1::/repo/unusable-timestamp'
    const edge = { ...lineage(childId, liveParentId), createdAt: Number.NaN }
    const worktreeLineageById = { [childId]: edge }
    const storeWithRevision = createStore(
      worktreeLineageById,
      {
        [worktreeWorkspaceKey(childId)]: {
          ...workspaceLineage(childId, liveParentId),
          createdAt: Number.NaN
        }
      },
      { [liveParentId]: { instanceId: edge.parentWorktreeInstanceId } as WorktreeMeta }
    )

    const { getLineageRevision: _missing, ...store } = storeWithRevision
    pruneLineageForMissingRepoWorktrees(
      store as never,
      repo,
      [
        {
          path: '/repo/live-parent',
          head: 'a',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ],
      SCAN_LINEAGE_REVISION
    )

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.removeWorkspaceLineage).not.toHaveBeenCalled()
  })

  it('protects cached replay with the scan revision captured before the write', () => {
    const liveParentId = 'repo-1::/repo/live-parent'
    const childId = 'repo-1::/repo/born-after-the-listing'
    const childEdge = { ...lineage(childId, liveParentId), createdAt: Number.NaN }
    const worktreeLineageById = { [childId]: childEdge }
    const workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(childId)]: {
        ...workspaceLineage(childId, liveParentId),
        createdAt: Number.NaN
      }
    }
    const metaById = {
      [liveParentId]: { instanceId: childEdge.parentWorktreeInstanceId } as WorktreeMeta
    }
    const store = createStore(
      worktreeLineageById,
      workspaceLineageByChildKey,
      metaById,
      SCAN_LINEAGE_REVISION + 1
    )
    const listing = [
      {
        path: '/repo/live-parent',
        head: 'a',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
    ]

    pruneLineageForMissingRepoWorktrees(store as never, repo, listing, SCAN_LINEAGE_REVISION)
    pruneLineageForMissingRepoWorktrees(store as never, repo, listing, SCAN_LINEAGE_REVISION)

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(store.removeWorkspaceLineage).not.toHaveBeenCalled()
  })
})
