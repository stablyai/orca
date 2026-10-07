import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorkspaceParent } from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

function makeWorktree(overrides: Partial<ResolvedWorktree> = {}): ResolvedWorktree {
  const git = {
    path: '/workspace/app',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
  return {
    ...git,
    id: 'repo-1::/workspace/app',
    repoId: 'repo-1',
    hostId: 'local',
    instanceId: 'instance-1',
    displayName: 'Child',
    comment: '',
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
    git,
    ...overrides
  }
}

function makeFolderParent(overrides: Partial<FolderWorkspace> = {}): ResolvedWorkspaceParent {
  const folderWorkspace: FolderWorkspace = {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'Ticket workspace',
    folderPath: '/workspace',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
  return {
    type: 'folder',
    workspaceKey: folderWorkspaceKey(folderWorkspace.id),
    folderWorkspace,
    instanceId: null
  }
}

function makeStore(): RuntimeStore {
  const store = {
    getRepos: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    setWorktreeMeta: vi.fn(),
    setWorktreeMetaForHost: vi.fn(),
    setWorktreeLineage: vi.fn(),
    removeWorktreeLineage: vi.fn(),
    setWorkspaceLineage: vi.fn()
  } satisfies Partial<RuntimeStore>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These metadata paths use only the checked store methods supplied above.
  return store as unknown as RuntimeStore
}

function makePorts(worktree: ResolvedWorktree, parent?: ResolvedWorkspaceParent) {
  return {
    resolveWorktree: vi.fn(async () => worktree),
    resolveParent: vi.fn(async () => {
      if (!parent) {
        throw new Error('selector_not_found')
      }
      return parent
    }),
    validateParent: vi.fn(),
    invalidateResolved: vi.fn(),
    invalidateScan: vi.fn(),
    notifyChanged: vi.fn(),
    showWorktree: vi.fn(async () => worktree)
  }
}

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('writes metadata through the resolved worktree execution host', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const store = makeStore()

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { comment: 'remote row only' },
      store,
      ports: makePorts(worktree)
    })

    expect(store.setWorktreeMetaForHost).toHaveBeenCalledWith(worktree.id, 'ssh:build-box', {
      comment: 'remote row only'
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('attaches a worktree to a folder workspace parent through workspace lineage only', async () => {
    const worktree = makeWorktree()
    const store = makeStore()
    const ports = makePorts(worktree, makeFolderParent())

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { lineage: { parentWorktree: 'folder:fw-1' } },
      store,
      ports
    })

    expect(store.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: 'instance-1',
        parentWorkspaceKey: 'folder:fw-1',
        parentInstanceId: null,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
    // A folder parent replaces any worktree parent; no worktree-lineage row remains.
    expect(store.removeWorktreeLineage).toHaveBeenCalledWith(worktree.id)
    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(ports.validateParent).not.toHaveBeenCalled()
    expect(ports.notifyChanged).toHaveBeenCalledWith('repo-1')
  })

  it('attaches a runtime-hosted worktree to a local folder workspace', async () => {
    // A runtime environment's own server is local to the work it runs, so the
    // folder's `local` answer is the same host the worktree reports.
    const worktree = makeWorktree({ hostId: 'runtime:env-1' })
    const store = makeStore()

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { lineage: { parentWorktree: 'folder:fw-1' } },
      store,
      ports: makePorts(worktree, makeFolderParent())
    })

    expect(store.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspaceKey: 'folder:fw-1' })
    )
  })

  it('attaches an ssh worktree to a folder workspace on the same ssh target', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const store = makeStore()

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { lineage: { parentWorktree: 'folder:fw-1' } },
      store,
      ports: makePorts(worktree, makeFolderParent({ connectionId: 'build-box' }))
    })

    expect(store.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspaceKey: 'folder:fw-1' })
    )
  })

  it('rejects a folder workspace parent on a different execution host', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const store = makeStore()

    await expect(
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { lineage: { parentWorktree: 'folder:fw-1' } },
        store,
        ports: makePorts(worktree, makeFolderParent())
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })

    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('rejects a folder workspace parent on a different ssh target', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const store = makeStore()

    await expect(
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { lineage: { parentWorktree: 'folder:fw-1' } },
        store,
        ports: makePorts(worktree, makeFolderParent({ connectionId: 'other-box' }))
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })

    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
  })

  it('rejects an ssh folder workspace parent for a runtime-hosted worktree', async () => {
    const worktree = makeWorktree({ hostId: 'runtime:env-a' })
    const store = makeStore()

    await expect(
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { lineage: { parentWorktree: 'folder:fw-1' } },
        store,
        ports: makePorts(worktree, makeFolderParent({ connectionId: 'build-box' }))
      })
    ).rejects.toMatchObject({ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' })

    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
  })
})
