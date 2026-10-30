import { runSerializedWorktreeRemovalAcceptance } from '../worktree-removal-acceptance-queue'
import { startBackgroundWorktreeRemoval } from '../worktree-background-removal'
import type { Repo } from '../../shared/repo-types'
import type { ExecutionHostId } from '../../shared/execution-host'
const archiveHooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../hooks', () => ({
  getEffectiveHooks: () => ({ scripts: { archive: 'stop environment' } }),
  runHook: archiveHooks.run
}))
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../shared/worktree/types'
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
      updates: { comment: 'remote row only' },
      store,
      ports
    })

    expect(setWorktreeMeta).toHaveBeenCalledExactlyOnceWith(
      hostWorktreeTarget({ id: worktree.id, hostId: 'ssh:build-box' }),
      { comment: 'remote row only' }
    )
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

describe('retained archive lifecycle', () => {
  function fixture(hostId: ExecutionHostId = 'local') {
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: hostId
    }
    let meta = { instanceId: 'first', isArchived: false }
    const setWorktreeMeta = vi.fn((_target, updates) => {
      meta = { ...meta, ...updates }
      return meta
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this metadata boundary reads only the supplied repository and host-qualified metadata accessors.
    const store = {
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorktreeMeta: () => meta,
      getWorktreeMetaForHost: () => meta,
      setWorktreeMeta
    } as unknown as RuntimeStore
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every identity field the metadata transition reads.
    const worktree = {
      id: 'repo::/repo/task',
      repoId: 'repo',
      path: '/repo/task',
      hostId,
      instanceId: 'first',
      isArchived: false
    } as ResolvedWorktree
    const ports = {
      resolveWorktree: async () => worktree,
      validateParent: () => {},
      invalidateResolved: () => {},
      invalidateScan: () => {},
      notifyChanged: () => {},
      showWorktree: async () => worktree
    }
    const setArchived = (isArchived: boolean) =>
      updateRuntimeManagedWorktreeMetadata({
        selector: 'identity:wt2:local:first',
        updates: { isArchived },
        store,
        ports
      })
    const archive = () => setArchived(true)
    return {
      archive,
      legacyArchive: () =>
        updateRuntimeManagedWorktreeMetadata({
          selector: 'id:repo::/repo/task',
          updates: { isArchived: true },
          store,
          ports
        }),
      setArchived,
      setWorktreeMeta,
      read: () => meta,
      replace: () => {
        meta = { instanceId: 'replacement', isArchived: false }
      }
    }
  }

  it('does not run a configured stop hook for a legacy path-only caller', async () => {
    const f = fixture()
    archiveHooks.run.mockReset()
    await expect(f.legacyArchive()).rejects.toMatchObject({
      code: 'worktree_archive_identity_required'
    })
    expect(archiveHooks.run).not.toHaveBeenCalled()
    expect(f.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps previous archive metadata when stop is unconfirmed', async () => {
    const f = fixture()
    archiveHooks.run.mockReset().mockResolvedValue({ success: false, output: 'lost stop outcome' })
    await expect(f.archive()).rejects.toThrow(/archive/i)
    expect(f.read().isArchived).toBe(false)
    expect(f.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not execute a runtime-owned mirror archive hook on this machine', async () => {
    const f = fixture('runtime:remote-host')
    archiveHooks.run.mockReset().mockResolvedValue({ success: true, output: '' })
    await expect(f.archive()).rejects.toThrow(/execution host/i)
    expect(archiveHooks.run).not.toHaveBeenCalled()
    expect(f.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('serializes duplicate archive requests and stops once', async () => {
    const f = fixture()
    archiveHooks.run.mockReset().mockResolvedValue({ success: true, output: '' })
    await Promise.all([f.archive(), f.archive()])
    expect(archiveHooks.run).toHaveBeenCalledTimes(1)
    expect(f.read().isArchived).toBe(true)
  })

  it('orders archive completion before deletion acceptance on the same repository', async () => {
    const f = fixture()
    const stop = Promise.withResolvers<{ success: boolean; output: string }>()
    archiveHooks.run.mockReset().mockReturnValue(stop.promise)
    const archiving = f.archive()
    await vi.waitFor(() => expect(archiveHooks.run).toHaveBeenCalled())
    let accepted = false
    const deletion = runSerializedWorktreeRemovalAcceptance('/repo', async () => {
      accepted = f.read().isArchived
    })
    await Promise.resolve()
    expect(accepted).toBe(false)
    stop.resolve({ success: true, output: '' })
    await Promise.all([archiving, deletion])
    expect(accepted).toBe(true)
    await f.setArchived(false)
    expect(f.read().isArchived).toBe(false)
    expect(archiveHooks.run).toHaveBeenCalledTimes(1)
  })

  it('does not archive a replacement instance after the stop hook returns', async () => {
    const f = fixture()
    archiveHooks.run.mockReset().mockImplementation(async () => {
      f.replace()
      return { success: true, output: '' }
    })
    await expect(f.archive()).rejects.toThrow(/changed/i)
    expect(f.setWorktreeMeta).not.toHaveBeenCalled()
    expect(f.read()).toEqual({ instanceId: 'replacement', isArchived: false })
  })

  it('does not run archive after background deletion has already been accepted', async () => {
    const f = fixture()
    archiveHooks.run.mockReset()
    const deleted = Promise.withResolvers<{}>()
    const removing = startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: 'repo::/repo/task',
        repoId: 'repo',
        repoPath: '/repo',
        worktree: { path: '/repo/task', branch: 'task', head: 'head' },
        deleteBranch: false,
        force: false
      },
      run: () => deleted.promise,
      publish: () => {}
    })
    try {
      await expect(f.archive()).rejects.toThrow(/deletion/i)
      expect(archiveHooks.run).not.toHaveBeenCalled()
      expect(f.setWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      deleted.resolve({})
      await removing
    }
  })
})
