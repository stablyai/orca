import { describe, expect, it, vi } from 'vitest'
import { recordWorktreeLineageForCreatedWorktree } from './worktree-create-lineage'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { WorktreeLineage } from '../../shared/types'

function makeStore(metaById: Record<string, { instanceId?: string }>) {
  return {
    getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
    setWorktreeLineage: vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
  }
}

const CHILD = { id: 'repo::child', instanceId: 'child-instance' }

describe('recordWorktreeLineageForCreatedWorktree', () => {
  // Why: the default keeps folder-scope creates attributed to the active workspace,
  // which is what the caller omitting a source has always meant.
  it('records worktree lineage for a worktree-type parent workspace', () => {
    const store = makeStore({ 'repo::parent': { instanceId: 'parent-instance' } })

    const lineage = recordWorktreeLineageForCreatedWorktree(
      store,
      worktreeWorkspaceKey('repo::parent'),
      CHILD,
      1234
    )

    expect(lineage).toEqual({
      worktreeId: 'repo::child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: 'repo::parent',
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'active-workspace', confidence: 'explicit' },
      createdAt: 1234
    })
    expect(store.setWorktreeLineage).toHaveBeenCalledWith('repo::child', lineage)
  })

  it('attributes an explicitly picked parent to a manual action', () => {
    const store = makeStore({ 'repo::parent': { instanceId: 'parent-instance' } })

    const lineage = recordWorktreeLineageForCreatedWorktree(
      store,
      worktreeWorkspaceKey('repo::parent'),
      CHILD,
      1234,
      'manual-action'
    )

    expect(lineage?.capture).toEqual({ source: 'manual-action', confidence: 'explicit' })
  })

  it('records nothing for folder-workspace parents', () => {
    const store = makeStore({})

    expect(
      recordWorktreeLineageForCreatedWorktree(store, folderWorkspaceKey('folder-1'), CHILD, 1)
    ).toBeNull()
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
  })

  it('records nothing without a parent workspace or instance identity', () => {
    const store = makeStore({ 'repo::parent': {} })

    expect(recordWorktreeLineageForCreatedWorktree(store, undefined, CHILD, 1)).toBeNull()
    expect(
      recordWorktreeLineageForCreatedWorktree(
        store,
        worktreeWorkspaceKey('repo::parent'),
        { id: 'repo::child', instanceId: undefined } as never,
        1
      )
    ).toBeNull()
    // Parent meta exists but has no instance id.
    expect(
      recordWorktreeLineageForCreatedWorktree(store, worktreeWorkspaceKey('repo::parent'), CHILD, 1)
    ).toBeNull()
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
  })

  it('refuses to attach a worktree to itself', () => {
    const store = makeStore({ 'repo::child': { instanceId: 'child-instance' } })

    expect(
      recordWorktreeLineageForCreatedWorktree(store, worktreeWorkspaceKey('repo::child'), CHILD, 1)
    ).toBeNull()
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
  })
})
