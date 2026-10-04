import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('writes metadata through the resolved worktree execution host', async () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:build-box',
      path: '/workspace/app',
      instanceId: 'instance-1'
    } as unknown as ResolvedWorktree
    const setWorktreeMeta = vi.fn()
    const setWorktreeMetaForHost = vi.fn()
    const store = { setWorktreeMeta, setWorktreeMetaForHost } as unknown as RuntimeStore
    const ports = {
      resolveWorktree: vi.fn(async () => worktree),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => worktree as unknown as Worktree)
    }

    await updateRuntimeManagedWorktreeMetadata({
      selector: `id:${worktree.id}`,
      updates: { comment: 'remote row only' },
      store,
      ports
    })

    expect(setWorktreeMetaForHost).toHaveBeenCalledWith(worktree.id, 'ssh:build-box', {
      comment: 'remote row only'
    })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  describe('cross-repo lineage (#8886)', () => {
    const resolved = (id: string): ResolvedWorktree => {
      const [repoId, path] = id.split('::')
      const git = {
        path,
        head: 'abc',
        branch: 'refs/heads/x',
        isBare: false,
        isMainWorktree: false
      }
      return {
        ...git,
        id,
        repoId,
        hostId: 'local',
        instanceId: `${id}-instance`,
        displayName: path,
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
        git
      }
    }

    function setup(previousParentId?: string) {
      const lineageById: Record<string, WorktreeLineage> = {}
      if (previousParentId) {
        lineageById['repo-child::/child'] = {
          worktreeId: 'repo-child::/child',
          worktreeInstanceId: 'repo-child::/child-instance',
          parentWorktreeId: previousParentId,
          parentWorktreeInstanceId: `${previousParentId}-instance`,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
      }
      const storeDouble = {
        setWorktreeMeta: vi.fn(),
        setWorktreeMetaForHost: vi.fn(),
        getWorktreeLineage: (id: string) => lineageById[id],
        setWorktreeLineage: vi.fn(),
        setWorkspaceLineage: vi.fn(),
        removeWorktreeLineage: vi.fn(),
        removeWorkspaceLineage: vi.fn()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the metadata update reads only these lineage and meta methods; the rest of RuntimeStore is unreached.
      const store = storeDouble as unknown as RuntimeStore
      const child = resolved('repo-child::/child')
      const ports = {
        resolveWorktree: vi.fn(async (selector: string) => resolved(selector.slice(3))),
        validateParent: vi.fn(),
        invalidateResolved: vi.fn(),
        invalidateScan: vi.fn(),
        notifyChanged: vi.fn(),
        showWorktree: vi.fn(async (): Promise<Worktree> => child)
      }
      return { store, ports }
    }

    it('invalidates and notifies the new parent repo as well as the child repo', async () => {
      const { store, ports } = setup()

      await updateRuntimeManagedWorktreeMetadata({
        selector: 'id:repo-child::/child',
        updates: { lineage: { parentWorktree: 'id:repo-parent::/parent' } },
        store,
        ports
      })

      expect(ports.invalidateScan.mock.calls.flat()).toEqual(['repo-child', 'repo-parent'])
      expect(ports.notifyChanged.mock.calls.flat().sort()).toEqual(['repo-child', 'repo-parent'])
    })

    it('notifies the previous parent repo on reparent and on unlink', async () => {
      const reparent = setup('repo-old::/old-parent')
      await updateRuntimeManagedWorktreeMetadata({
        selector: 'id:repo-child::/child',
        updates: { lineage: { parentWorktree: 'id:repo-parent::/parent' } },
        store: reparent.store,
        ports: reparent.ports
      })
      expect(reparent.ports.notifyChanged.mock.calls.flat().sort()).toEqual([
        'repo-child',
        'repo-old',
        'repo-parent'
      ])

      const unlink = setup('repo-old::/old-parent')
      await updateRuntimeManagedWorktreeMetadata({
        selector: 'id:repo-child::/child',
        updates: { lineage: { noParent: true } },
        store: unlink.store,
        ports: unlink.ports
      })
      expect(unlink.ports.notifyChanged.mock.calls.flat().sort()).toEqual([
        'repo-child',
        'repo-old'
      ])
    })

    it('notifies only the child repo for a metadata-only update', async () => {
      const { store, ports } = setup('repo-old::/old-parent')

      await updateRuntimeManagedWorktreeMetadata({
        selector: 'id:repo-child::/child',
        updates: { comment: 'note' },
        store,
        ports
      })

      expect(ports.notifyChanged.mock.calls.flat()).toEqual(['repo-child'])
    })
  })
})
