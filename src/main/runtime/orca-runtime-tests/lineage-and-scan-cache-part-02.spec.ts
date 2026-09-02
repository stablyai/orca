import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, join, listWorktrees, tmpdir } from '../orca-runtime-test-mocks.spec'
import type { WorktreeLineage, WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('strips Orca provenance fields from runtime metadata updates', async () => {
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeMeta = vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
      return metaById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${TEST_WORKTREE_ID}`, {
      comment: 'keep me',
      orcaCreatedAt: 123,
      orcaCreationSource: 'runtime',
      orcaCreationWorkspaceLayout: { path: '/tmp', nestWorkspaces: false }
    })

    expect(setWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, { comment: 'keep me' })
  })

  it('ignores stale instance-mismatched lineage when validating manual cycle repairs', async () => {
    const parentPath = '/tmp/worktree-a'
    const childPath = '/tmp/worktree-b'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'new-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) =>
        worktreeId === parentId
          ? {
              worktreeId: parentId,
              worktreeInstanceId: 'old-parent-instance',
              parentWorktreeId: childId,
              parentWorktreeInstanceId: 'child-instance',
              origin: 'manual' as const,
              capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
              createdAt: 1
            }
          : undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/a',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/b',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'new-parent-instance'
      })
    )
  })

  it('rejects lineage updates when upgraded metadata is missing a parent instance id', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta(),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage) => lineage)
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow('Worktree instance identity was unavailable')

    expect(runtimeStore.setWorktreeLineage).not.toHaveBeenCalled()
  })

  it('rotates a missing parent instance during runtime selector scans before same-path reuse', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'old-parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'old-parent-instance',
        origin: 'manual' as const,
        capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
        createdAt: 1
      }
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage: vi.fn((worktreeId: string) => {
        delete lineageById[worktreeId]
      }),
      setWorktreeLineage
    }
    vi.mocked(listWorktrees)
      .mockResolvedValueOnce([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValue([
        {
          path: childPath,
          head: 'def',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: parentPath,
          head: 'abc',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.showManagedWorktree(`id:${childId}`)
    const rotatedParentInstance = metaById[parentId].instanceId
    expect(rotatedParentInstance).toBeTruthy()
    expect(rotatedParentInstance).not.toBe('old-parent-instance')
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'rescanned' })
    expect(metaById[parentId].instanceId).toBe(rotatedParentInstance)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, { comment: 'touch' })
    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeInstanceId: 'child-instance',
        parentWorktreeInstanceId: rotatedParentInstance
      })
    )
  })

  it('does not prune lineage when a runtime local worktree scan fails', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const removeWorktreeLineage = vi.fn((worktreeId: string) => {
      delete lineageById[worktreeId]
    })
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      }),
      getAllWorktreeLineage: () => lineageById,
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.showManagedWorktree(`id:${childId}`)).rejects.toThrow('selector_not_found')

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
    expect(runtimeStore.setWorktreeMeta).not.toHaveBeenCalled()
    expect(lineageById[childId]).toBeTruthy()
    expect(metaById[parentId].instanceId).toBe('parent-instance')
  })

  it('returns a non-authoritative detected list when a runtime local worktree scan fails', async () => {
    const removeWorktreeLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeLineage: () => ({}),
      removeWorktreeLineage
    }
    vi.mocked(listWorktrees).mockRejectedValueOnce(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toEqual({
      repoId: TEST_REPO_ID,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })

    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('revalidates missing worktrees before stopping their local provider sessions', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const survivingId = `${TEST_REPO_ID}::/tmp/surviving`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' },
        { id: `${survivingId}@@surviving-session`, cwd: '/tmp/surviving', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: [{ id: survivingId }] as never
    })

    const result = await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      deletedId,
      survivingId
    ])

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalledWith(
      `${survivingId}@@surviving-session`,
      expect.anything()
    )
  })

  // Why (#10562): the renderer purges its state regardless of the sweep result, so
  // revalidating against a cached scan (30s TTL) that still lists an already-deleted
  // directory would strand those PTYs permanently — nothing asks a second time.
  it('revalidates against a fresh scan instead of a warm worktree-scan cache', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })

    // Warm the scan cache while the worktree still exists.
    vi.mocked(listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/deleted', head: 'abc', branch: 'd', isBare: false, isMainWorktree: false }
    ])
    await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [deletedId])
    expect(localProvider.shutdown).not.toHaveBeenCalled()

    // The worktree is now gone; the cached scan must not mask that.
    vi.mocked(listWorktrees).mockResolvedValue([])
    const result = await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      deletedId
    ])

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
  })

  it('does not stop sessions after a non-authoritative revalidation', async () => {
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getLocalProvider: () => localProvider as never
    })
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })

    await runtime.teardownMissingManagedWorktreeTerminals(`id:${TEST_REPO_ID}`, [
      `${TEST_REPO_ID}::/tmp/deleted`
    ])

    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })

  // Why: an explicit connection identity only narrows the selector, it must not
  // change the grammar. Treating the selector as a bare repo id made every
  // `path:`/`name:` selector fail repo_not_found on this path alone.
  it('resolves non-id selectors when a connection identity is supplied', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@deleted-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const localRepo = store.getRepos()[0]
    const runtime = new OrcaRuntimeService(
      { ...store, getRepos: () => [localRepo, { ...localRepo, connectionId: 'ssh-1' }] } as never,
      undefined,
      { getLocalProvider: () => localProvider as never }
    )
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: []
    })

    // `path:` is ambiguous across the two rows; connectionId null selects the local one.
    const result = await runtime.teardownMissingManagedWorktreeTerminals(
      `path:${localRepo.path}`,
      [deletedId],
      null
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
  })

  it('uses the connection-scoped repo when local and SSH repo ids collide', async () => {
    const deletedId = `${TEST_REPO_ID}::/tmp/deleted`
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const sshProvider = {
      listProcesses: vi.fn(async () => [
        { id: `${deletedId}@@ssh-session`, cwd: '/tmp/deleted', title: 'shell' }
      ]),
      shutdown: vi.fn(async () => {})
    }
    const localRepo = store.getRepos()[0]
    const sshRepo = { ...localRepo, connectionId: 'ssh-1' }
    const runtime = new OrcaRuntimeService(
      {
        ...store,
        getRepos: () => [localRepo, sshRepo]
      } as never,
      undefined,
      {
        getLocalProvider: () => localProvider as never,
        getSshProvider: (connectionId) =>
          connectionId === 'ssh-1' ? (sshProvider as never) : undefined
      }
    )
    vi.spyOn(
      runtime as unknown as { listDetectedWorktreesForResolvedRepo: () => unknown },
      'listDetectedWorktreesForResolvedRepo'
    ).mockResolvedValue({
      repoId: TEST_REPO_ID,
      authoritative: true,
      source: 'git',
      worktrees: []
    })

    await runtime.teardownMissingManagedWorktreeTerminals(TEST_REPO_ID, [deletedId], 'ssh-1')

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@ssh-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })

  it('hydrates runtime detected lists with instance-validated legacy lineage', async () => {
    const parentPath = join(tmpdir(), 'worktree-parent')
    const childPath = join(tmpdir(), 'worktree-child')
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      getAllWorktreeLineage: () => lineageById
    } as never)
    vi.mocked(listWorktrees).mockResolvedValue([
      makeWorktreeInfo(childPath),
      makeWorktreeInfo(parentPath)
    ])

    const result = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({ parentWorktreeInstanceId: 'parent-instance' })
      }),
      expect.objectContaining({
        id: parentId,
        parentWorktreeId: null,
        childWorktreeIds: [childId],
        lineage: null
      })
    ])
  })

  it('hydrates folder-repo detected rows with instance-validated legacy lineage', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: 'blue' as const,
      addedAt: 1,
      kind: 'folder' as const
    }
    const parentId = `${folderRepo.id}::${folderRepo.path}`
    const childId = `${parentId}::workspace:child-instance`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getAllWorktreeLineage: () => lineageById
    } as never)

    const result = await runtime.listDetectedManagedWorktrees(`id:${folderRepo.id}`)

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: parentId,
        parentWorktreeId: null,
        childWorktreeIds: [childId],
        lineage: null
      }),
      expect.objectContaining({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({ parentWorktreeInstanceId: 'parent-instance' })
      })
    ])
  })

  it('keeps colliding folder workspace metadata scoped to its owning host', async () => {
    const localRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'local-folder',
      badgeColor: 'blue' as const,
      addedAt: 1,
      kind: 'folder' as const
    }
    const remoteRepo = {
      ...localRepo,
      displayName: 'remote-folder',
      connectionId: 'ssh-1'
    }
    const rootId = `${localRepo.id}::${localRepo.path}`
    const childId = `${rootId}::workspace:local-child`
    const metaById: Record<string, WorktreeMeta> = {
      [rootId]: makeWorktreeMeta({
        hostId: 'local',
        displayName: 'local-root-name',
        comment: 'local-only-comment',
        isPinned: true
      }),
      [childId]: makeWorktreeMeta({
        hostId: 'local',
        instanceId: 'local-child',
        displayName: 'local-child-name'
      })
    }
    const setWorktreeMeta = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta
    } as never)

    const result = await runtime.listDetectedManagedWorktrees(`id:${remoteRepo.id}`, 'ssh-1')

    expect(result.worktrees).toEqual([
      expect.objectContaining({
        id: rootId,
        hostId: 'ssh:ssh-1',
        displayName: 'remote-folder',
        comment: '',
        isPinned: false
      })
    ])
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })
})
