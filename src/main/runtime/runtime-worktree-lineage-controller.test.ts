import { describe, expect, it, vi } from 'vitest'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeStore } from './runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'

function resolved(id: string, comment = ''): ResolvedWorktree {
  const [repoId, path] = id.split('::')
  const git = { path, head: 'abc', branch: 'refs/heads/x', isBare: false, isMainWorktree: false }
  return {
    ...git,
    id,
    repoId,
    hostId: 'local',
    instanceId: `${id}-instance`,
    displayName: path,
    comment,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git
  }
}

function setup(childComment: string) {
  const parent = resolved('repo-parent::/parent')
  const child = resolved('repo-child::/child', childComment)
  const lineageById: Record<string, WorktreeLineage> = {}
  const storeDouble = {
    getWorktreeLineage: (id: string) => lineageById[id],
    setWorktreeLineage: vi.fn((id: string, lineage: WorktreeLineage) => {
      lineageById[id] = lineage
      return lineage
    })
  }
  const dbDouble = {
    getDispatchContext: () => ({ assignee_handle: 'term_parent' }),
    getTask: () => undefined
  }
  const invalidateResolvedWorktrees = vi.fn()
  const controller = new RuntimeWorktreeLineageController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hydrate reads and writes only worktree lineage on the store.
    getStore: () => storeDouble as unknown as RuntimeStore,
    getCachedWorktrees: () => null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: task-candidate resolution reads only these two queries.
    getDb: () => dbDouble as unknown as OrchestrationDb,
    resolveWorktree: async (selector) => (selector === `id:${parent.id}` ? parent : child),
    listResolvedWorktrees: async () => [parent, child],
    invalidateResolvedWorktrees,
    showTerminal: async () => ({ worktreeId: parent.id })
  })
  return { controller, storeDouble, invalidateResolvedWorktrees, parent, child }
}

describe('RuntimeWorktreeLineageController.hydrate', () => {
  it('invalidates the resolved snapshot after inferring a cross-repo edge (#8886)', async () => {
    const { controller, storeDouble, invalidateResolvedWorktrees, parent, child } =
      setup('Working on task_ABC123')

    await controller.hydrate()

    expect(storeDouble.setWorktreeLineage).toHaveBeenCalledWith(
      child.id,
      expect.objectContaining({ parentWorktreeId: parent.id })
    )
    expect(invalidateResolvedWorktrees).toHaveBeenCalledTimes(1)
  })

  it('leaves the snapshot cached when nothing was inferred', async () => {
    const { controller, storeDouble, invalidateResolvedWorktrees } = setup('no task here')

    await controller.hydrate()

    expect(storeDouble.setWorktreeLineage).not.toHaveBeenCalled()
    expect(invalidateResolvedWorktrees).not.toHaveBeenCalled()
  })
})
