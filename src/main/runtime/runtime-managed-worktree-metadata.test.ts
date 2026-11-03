import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../shared/worktree/types'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

describe('updateRuntimeManagedWorktreeMetadata', () => {
  it('writes metadata through the resolved host without accepting forged GitHub ownership', async () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'ssh:build-box',
      path: '/workspace/app',
      instanceId: 'instance-1'
    } as unknown as ResolvedWorktree
    const setWorktreeMeta = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update only reads these store members.
    const store = {
      getRepos: () => [],
      setWorktreeMeta
    } as unknown as RuntimeStore
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
      updates: {
        comment: 'remote row only',
        githubExecutionIdentity: {
          repoId: 'repo-1',
          participantId: 'forged',
          account: { host: 'github.com', user: 'owner' }
        }
      },
      store,
      ports
    })

    expect(setWorktreeMeta).toHaveBeenCalledExactlyOnceWith(
      hostWorktreeTarget({ id: worktree.id, hostId: 'ssh:build-box' }),
      { comment: 'remote row only' }
    )
  })

  it('persists an empty comment so a set comment can be cleared (#37464)', async () => {
    const worktree = {
      id: 'repo-1::/workspace/app',
      repoId: 'repo-1',
      hostId: 'local',
      path: '/workspace/app',
      instanceId: 'instance-1'
    } as unknown as ResolvedWorktree
    let row: WorktreeMeta | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update only reads these store members.
    const store = {
      getRepos: () => [],
      setWorktreeMeta: (_target: unknown, meta: Partial<WorktreeMeta>) => {
        row = mergeWorktreeMetaForWrite(row, meta)
      }
    } as unknown as RuntimeStore
    const ports = {
      resolveWorktree: vi.fn(async () => worktree),
      validateParent: vi.fn(),
      invalidateResolved: vi.fn(),
      invalidateScan: vi.fn(),
      notifyChanged: vi.fn(),
      showWorktree: vi.fn(async () => worktree as unknown as Worktree)
    }
    const update = (comment: string) =>
      updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { comment },
        store,
        ports
      })

    await update('waiting on review')
    expect(row?.comment).toBe('waiting on review')

    await update('')
    expect(row?.comment).toBe('')
  })

  describe('a folder workspace removed while its resolution was in flight (#22712)', () => {
    const folderRepo = { id: 'repo-1', path: '/workspace/app', displayName: 'app', kind: 'folder' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update only reads id, repoId, hostId and instanceId.
    const worktree = {
      id: 'repo-1::/workspace/app::workspace:0b6f6d2e-1c1d-4c55-9a51-3f1c0f4f2a10',
      repoId: 'repo-1',
      hostId: 'local',
      path: '/workspace/app',
      instanceId: 'instance-1'
    } as unknown as ResolvedWorktree

    function run(meta: Partial<WorktreeMeta> | undefined) {
      const setWorktreeMeta = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update only reads these store members.
      const store = {
        getRepos: () => [folderRepo],
        getWorktreeMeta: () => meta,
        getWorktreeMetaForHost: () => meta,
        setWorktreeMeta
      } as unknown as RuntimeStore
      const result = updateRuntimeManagedWorktreeMetadata({
        selector: `id:${worktree.id}`,
        updates: { lastActivityAt: 2 },
        store,
        ports: {
          resolveWorktree: vi.fn(async () => worktree),
          validateParent: vi.fn(),
          invalidateResolved: vi.fn(),
          invalidateScan: vi.fn(),
          notifyChanged: vi.fn(),
          showWorktree: vi.fn(async () => worktree as unknown as Worktree)
        }
      })
      return { result, setWorktreeMeta }
    }

    it('refuses to recreate the removed workspace as a blank row', async () => {
      const { result, setWorktreeMeta } = run(undefined)

      await expect(result).rejects.toThrow('selector_not_found')
      expect(setWorktreeMeta).not.toHaveBeenCalled()
    })

    it('still writes to a folder workspace that exists', async () => {
      const { result, setWorktreeMeta } = run({ instanceId: 'instance-1' })

      await result
      expect(setWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktree.id, hostId: 'local' }),
        { lastActivityAt: 2 }
      )
    })
  })
})
