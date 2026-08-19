import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesMock, getSshGitProviderMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('stamps lastActivityAt on first discovery so newly-added worktrees sort to the top of Recent', async () => {
    // Why: a worktree on disk with no persisted WorktreeMeta would otherwise fall back to lastActivityAt: 0 and rank dead last in Recent.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/discovered-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue(undefined)
    const stampedMeta = {
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 1_700_000_000_000
    }
    store.setWorktreeMeta.mockReturnValue(stampedMeta)

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      lastActivityAt: number
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/discovered-wt',
      expect.objectContaining({
        lastActivityAt: expect.any(Number),
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      })
    )
    expect(listed[0]).toMatchObject({
      id: 'repo-1::/workspace/discovered-wt',
      lastActivityAt: 1_700_000_000_000
    })
  })

  it('backfills project-host ownership without re-stamping lastActivityAt for existing meta', async () => {
    // Why: only first discovery stamps (re-stamping would reshuffle the sidebar); host ownership is still backfilled since it derives from repo setup.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      instanceId: 'existing-instance',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })
    store.setWorktreeMeta.mockReturnValue({
      instanceId: 'existing-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 42
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      lastActivityAt: number
      projectId?: string
      hostId?: string
      projectHostSetupId?: string
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/existing-wt', {
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1'
    })
    expect(listed[0].lastActivityAt).toBe(42)
    expect(listed[0]).toMatchObject({
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1'
    })
  })

  it('repairs legacy project ids when discovery now resolves the same host setup to a logical project', async () => {
    // Why: provider identity can arrive after metadata was written; existing workspaces must move to the logical project ID without losing activity ordering.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getProjectHostSetups.mockReturnValue([
      {
        id: 'repo-1',
        projectId: 'github:stablyai/orca',
        hostId: 'local',
        repoId: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 0,
        updatedAt: 0
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      instanceId: 'existing-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })
    store.setWorktreeMeta.mockReturnValue({
      instanceId: 'existing-instance',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 42
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      lastActivityAt: number
      projectId?: string
      hostId?: string
      projectHostSetupId?: string
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/existing-wt', {
      projectId: 'github:stablyai/orca'
    })
    expect(listed[0]).toMatchObject({
      id: 'repo-1::/workspace/existing-wt',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 42
    })
  })

  it('does not repair ownership when discovery points at a different project-host setup', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getProjectHostSetups.mockReturnValue([
      {
        id: 'repo-1',
        projectId: 'github:stablyai/orca',
        hostId: 'local',
        repoId: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 0,
        updatedAt: 0
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      instanceId: 'existing-instance',
      projectId: 'github:other/project',
      hostId: 'ssh:ssh-target-1',
      projectHostSetupId: 'repo-other-host',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })

    await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('repairs legacy project ids when SSH worktree listing falls back to persisted metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/orca',
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-target-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/orca': makeWorktreeMeta({
        instanceId: 'existing-instance',
        projectId: 'repo:repo-ssh',
        hostId: 'ssh:ssh-target-1',
        projectHostSetupId: 'repo-ssh',
        lastActivityAt: 42
      })
    })
    store.getProjectHostSetups.mockReturnValue([
      {
        id: 'repo-ssh',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:ssh-target-1',
        repoId: 'repo-ssh',
        path: '/remote/orca',
        displayName: 'orca',
        setupState: 'ready',
        setupMethod: 'imported-existing-folder',
        createdAt: 0,
        updatedAt: 0
      }
    ])
    store.setWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({
        instanceId: 'existing-instance',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:ssh-target-1',
        projectHostSetupId: 'repo-ssh',
        lastActivityAt: 42
      })
    )

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })) as {
      id: string
      projectId?: string
      hostId?: string
      projectHostSetupId?: string
      lastActivityAt: number
    }[]

    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-target-1')
    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-ssh::/remote/orca', {
      projectId: 'github:stablyai/orca'
    })
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/orca',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:ssh-target-1',
        projectHostSetupId: 'repo-ssh',
        lastActivityAt: 42
      })
    ])
  })

  it('does not rewrite discovery metadata when instance and project-host ownership already exist', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      instanceId: 'existing-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })

    await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('backfills instanceId on discovery for persisted metadata from older profiles', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/existing-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })
    store.setWorktreeMeta.mockReturnValue({
      instanceId: 'new-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 42
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as {
      id: string
      instanceId?: string
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/existing-wt',
      expect.objectContaining({
        instanceId: expect.any(String),
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      })
    )
    expect(listed[0]).toMatchObject({
      instanceId: 'new-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1'
    })
  })

  it('stamps lastActivityAt on first discovery for folder-mode repos', async () => {
    // Why: folder repos produce a synthetic worktree; without the stamp a just-added folder sorts to the bottom of Recent.
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      lastActivityAt: 1_700_000_000_000
    })

    await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/folder',
      expect.objectContaining({
        lastActivityAt: expect.any(Number),
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      })
    )
  })

  it('stamps lastActivityAt on first discovery via worktrees:listAll', async () => {
    // Why: stamping logic is duplicated in worktrees:list and worktrees:listAll; a listAll regression would silently bury newly-discovered worktrees.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/discovered-wt',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({ lastActivityAt: 1_700_000_000_000 })

    const listed = (await handlers['worktrees:listAll'](null, undefined)) as {
      id: string
      lastActivityAt: number
    }[]

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/discovered-wt',
      expect.objectContaining({ lastActivityAt: expect.any(Number) })
    )
    expect(listed[0]).toMatchObject({
      id: 'repo-1::/workspace/discovered-wt',
      lastActivityAt: 1_700_000_000_000
    })
  })

  it('omits prunable worktrees from worktrees:listAll', async () => {
    // Why: a prunable registration has no working directory (issue #8389), so surfacing it yields repeated pty/fs failures and a blank pane.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/stale-wt',
        head: 'def456',
        branch: 'refs/heads/stale',
        isBare: false,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
        isMainWorktree: false
      },
      {
        path: '/workspace/live-wt',
        head: 'fed789',
        branch: 'refs/heads/live',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({ lastActivityAt: 1_700_000_000_000 })

    const listed = (await handlers['worktrees:listAll'](null, undefined)) as { id: string }[]
    const listedIds = listed.map((worktree) => worktree.id)

    expect(listedIds).toContain('repo-1::/workspace/live-wt')
    expect(listedIds).not.toContain('repo-1::/workspace/stale-wt')
  })

  it('limits concurrent repo scans in worktrees:listAll while preserving order', async () => {
    const repos = Array.from({ length: 10 }, (_, index) => ({
      id: `repo-${index}`,
      path: `/workspace/repo-${index}`,
      displayName: `repo-${index}`,
      badgeColor: '#000',
      addedAt: 0
    }))
    store.getRepos.mockReturnValue(repos)
    let activeScans = 0
    let maxActiveScans = 0
    let notifyScanStarted: (() => void) | undefined
    const waitForScanCount = async (count: number): Promise<void> => {
      while (listWorktreesMock.mock.calls.length < count) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for ${count} scans`)),
            1000
          )
          notifyScanStarted = () => {
            clearTimeout(timeout)
            resolve()
          }
        })
      }
    }
    const pendingScans: (() => void)[] = []
    listWorktreesMock.mockImplementation(
      async (
        repoPath: string
      ): Promise<
        { path: string; head: string; branch: string; isBare: false; isMainWorktree: true }[]
      > => {
        activeScans += 1
        maxActiveScans = Math.max(maxActiveScans, activeScans)
        await new Promise<void>((resolve) => {
          pendingScans.push(resolve)
          notifyScanStarted?.()
          notifyScanStarted = undefined
        })
        activeScans -= 1
        return [
          {
            path: repoPath,
            head: 'abc123',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ]
      }
    )

    const listPromise = handlers['worktrees:listAll'](null, undefined) as Promise<
      { path: string }[]
    >
    await Promise.resolve()

    expect(listWorktreesMock).toHaveBeenCalledTimes(8)
    expect(maxActiveScans).toBe(8)

    for (const resolve of pendingScans.splice(0)) {
      resolve()
    }
    await waitForScanCount(10)

    expect(listWorktreesMock).toHaveBeenCalledTimes(10)

    for (const resolve of pendingScans.splice(0)) {
      resolve()
    }
    const listed = await listPromise

    expect(maxActiveScans).toBe(8)
    expect(listed.map((worktree) => worktree.path)).toEqual(repos.map((repo) => repo.path))
  })
})
