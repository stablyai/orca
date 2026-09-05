import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Worktree } from '../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorkspaceParent } from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

function makeWorktree(overrides: Partial<ResolvedWorktree> = {}): ResolvedWorktree {
  return {
    id: 'repo-1::/workspace/app',
    repoId: 'repo-1',
    hostId: 'local',
    path: '/workspace/app',
    instanceId: 'instance-1',
    ...overrides
  } as unknown as ResolvedWorktree
}

function makeFolderParent(overrides: Partial<FolderWorkspace> = {}): ResolvedWorkspaceParent {
  const folderWorkspace = {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'Ticket workspace',
    folderPath: '/workspace',
    connectionId: null,
    linkedTask: null,
    ...overrides
  } as unknown as FolderWorkspace
  return {
    type: 'folder',
    workspaceKey: folderWorkspaceKey(folderWorkspace.id),
    folderWorkspace,
    instanceId: null
  }
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
    showWorktree: vi.fn(async () => worktree as unknown as Worktree)
  }
}

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('writes metadata through the resolved worktree execution host', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const setWorktreeMeta = vi.fn()
    const setWorktreeMetaForHost = vi.fn()
    const store = { setWorktreeMeta, setWorktreeMetaForHost } as unknown as RuntimeStore

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { comment: 'remote row only' },
      store,
      ports: makePorts(worktree)
    })

    expect(setWorktreeMetaForHost).toHaveBeenCalledWith(worktree.id, 'ssh:build-box', {
      comment: 'remote row only'
    })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('attaches a worktree to a folder workspace parent through workspace lineage only', async () => {
    const worktree = makeWorktree()
    const store = {
      setWorktreeMeta: vi.fn(),
      setWorktreeLineage: vi.fn(),
      removeWorktreeLineage: vi.fn(),
      setWorkspaceLineage: vi.fn()
    } as unknown as RuntimeStore
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

  it('rejects a folder workspace parent on a different execution host', async () => {
    const worktree = makeWorktree({ hostId: 'ssh:build-box' })
    const store = {
      setWorktreeMeta: vi.fn(),
      setWorktreeMetaForHost: vi.fn(),
      setWorktreeLineage: vi.fn(),
      removeWorktreeLineage: vi.fn(),
      setWorkspaceLineage: vi.fn()
    } as unknown as RuntimeStore

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
})
