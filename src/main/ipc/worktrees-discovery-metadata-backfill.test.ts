import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta, expectDetectedWorktreeListResult } from './worktrees-test-fixtures'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

describe('registerWorktreeHandlers', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('stamps lastActivityAt on first discovery so newly-added worktrees sort to the top of Recent', async () => {
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })
    )

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/discovered-wt', hostId: 'local' }),
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })
    )

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/existing-wt', hostId: 'local' }),
      {
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      }
    )
    expect(listed[0].lastActivityAt).toBe(42)
    expect(listed[0]).toMatchObject({
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1'
    })
  })

  it('repairs legacy project ids when discovery now resolves the same host setup to a logical project', async () => {
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })
    )

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/existing-wt', hostId: 'local' }),
      {
        projectId: 'github:stablyai/orca'
      }
    )
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
      hostId: 'local',
      projectHostSetupId: 'repo-other-setup',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 42
    })

    const result = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    )

    expect(result.authoritative).toBe(true)
    expect(result.worktrees[0]).toMatchObject({
      id: 'repo-1::/workspace/existing-wt',
      projectId: 'github:other/project'
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('repairs legacy project ids when an SSH worktree lists from persisted metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/orca',
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-target-1'
    }
    store.getRepos.mockReturnValue([repo])
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-ssh'
      })
    )

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-ssh::/remote/orca', hostId: 'ssh:ssh-target-1' }),
      {
        projectId: 'github:stablyai/orca'
      }
    )
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

    const result = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    )

    expect(result.authoritative).toBe(true)
    expect(result.worktrees.map((worktree) => worktree.id)).toContain(
      'repo-1::/workspace/existing-wt'
    )
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })
    )

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/existing-wt', hostId: 'local' }),
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

    await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-1::/workspace/folder', hostId: 'local' }),
      expect.objectContaining({
        lastActivityAt: expect.any(Number),
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      })
    )
  })

  it('omits prunable worktrees from worktrees:listDetected', async () => {
    // Prunable registrations have no working directory; listing them causes PTY/filesystem failures.
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

    const { worktrees: listed } = expectDetectedWorktreeListResult(
      await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })
    )
    const listedIds = listed.map((worktree) => worktree.id)

    expect(listedIds).toContain('repo-1::/workspace/live-wt')
    expect(listedIds).not.toContain('repo-1::/workspace/stale-wt')
  })
})
