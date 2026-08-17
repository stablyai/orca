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

  it('lists a synthetic worktree for folder-mode repos', async () => {
    const rootWorktreeId = 'repo-1::/workspace/folder'
    const priorWorktreeIds = ['repo-1::/workspace/old-folder']
    const rootMeta = makeWorktreeMeta({
      instanceId: 'folder-instance',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      priorWorktreeIds
    })
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
    store.getAllWorktreeMeta.mockReturnValue({
      [rootWorktreeId]: rootMeta
    })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === rootWorktreeId ? rootMeta : undefined
    )

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: rootWorktreeId,
        repoId: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        branch: '',
        head: '',
        isMainWorktree: true,
        priorWorktreeIds
      })
    ])
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('returns reconstructed rows when an SSH provider is unavailable', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({
        displayName: 'Feature workspace',
        comment: 'persisted comment',
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'LIN-123',
        isArchived: true,
        isUnread: true,
        isPinned: true,
        sortOrder: 7,
        lastActivityAt: 42,
        workspaceStatus: 'blocked',
        diffComments: [
          {
            id: 'comment-1',
            worktreeId: 'repo-ssh::/remote/feature-wt',
            filePath: 'src/app.ts',
            lineNumber: 10,
            body: 'check this',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1'
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        repoId: 'repo-ssh',
        path: '/remote/feature-wt',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: false,
        isSparse: true,
        displayName: 'Feature workspace',
        comment: 'persisted comment',
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'LIN-123',
        isArchived: true,
        isUnread: true,
        isPinned: true,
        sortOrder: 7,
        lastActivityAt: 42,
        workspaceStatus: 'blocked',
        sparseDirectories: ['packages/web'],
        sparseBaseRef: 'origin/main',
        sparsePresetId: 'preset-1',
        diffComments: [
          expect.objectContaining({
            id: 'comment-1',
            filePath: 'src/app.ts'
          })
        ]
      })
    ])
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-ssh::/remote/feature-wt', {
      projectId: 'repo:repo-ssh',
      hostId: 'ssh:conn-1',
      projectHostSetupId: 'repo-ssh'
    })
  })

  it('falls back to reconstructed SSH rows when provider listing throws', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const provider = {
      listWorktrees: vi.fn().mockRejectedValue(new Error('connection lost'))
    }
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(provider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    ])
  })

  it('keeps local listing failure behavior as an empty list', async () => {
    listWorktreesMock.mockRejectedValue(new Error('filesystem denied'))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({
        displayName: 'Should not appear'
      })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(listed).toEqual([])
    expect(store.getAllWorktreeMeta).not.toHaveBeenCalled()
  })

  it('ignores malformed metadata keys during SSH fallback', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'not-a-worktree-id': makeWorktreeMeta({ displayName: 'Bad row' }),
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({ displayName: 'Good row' })
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        displayName: 'Good row'
      })
    ])
  })

  it('does not use the repo display name for sparse fallback rows with empty branches', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/custom-name': makeWorktreeMeta({
        sparseDirectories: ['packages/web']
      })
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })) as {
      displayName: string
      isSparse?: boolean
      sparseDirectories?: string[]
    }[]

    expect(listed[0]).toMatchObject({
      displayName: 'custom-name',
      isSparse: true,
      sparseDirectories: ['packages/web']
    })
  })

  it('uses path equivalence to mark the reconstructed SSH main worktree', async () => {
    const repo = {
      id: 'repo-ssh',
      path: 'C:\\Remote\\Repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::c:/remote/repo': makeWorktreeMeta()
    })

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })) as {
      isMainWorktree: boolean
    }[]

    expect(listed[0].isMainWorktree).toBe(true)
  })

  it('includes SSH fallback rows in listAll alongside healthy local rows', async () => {
    const sshRepo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const localRepo = {
      id: 'repo-local',
      path: '/workspace/local',
      displayName: 'Local Repo',
      badgeColor: '#111',
      addedAt: 0
    }
    store.getRepos.mockReturnValue([sshRepo, localRepo])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({ displayName: 'Remote cached' })
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/local',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const listed = await handlers['worktrees:listAll'](null, undefined)

    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repo-ssh::/remote/feature-wt',
          displayName: 'Remote cached'
        }),
        expect.objectContaining({
          id: 'repo-local::/workspace/local',
          branch: 'refs/heads/main'
        })
      ])
    )
  })

  it('snapshots SSH fallback metadata once for listAll', async () => {
    const sshRepoA = {
      id: 'repo-ssh-a',
      path: '/remote/a',
      displayName: 'SSH A',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const sshRepoB = {
      id: 'repo-ssh-b',
      path: '/remote/b',
      displayName: 'SSH B',
      badgeColor: '#111',
      addedAt: 0,
      connectionId: 'conn-2'
    }
    store.getRepos.mockReturnValue([sshRepoA, sshRepoB])
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh-a::/remote/a/one': makeWorktreeMeta({ displayName: 'One' }),
      'repo-ssh-b::/remote/b/two': makeWorktreeMeta({ displayName: 'Two' })
    })

    const listed = await handlers['worktrees:listAll'](null, undefined)

    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(listed).toEqual([
      expect.objectContaining({ id: 'repo-ssh-a::/remote/a/one' }),
      expect.objectContaining({ id: 'repo-ssh-b::/remote/b/two' })
    ])
  })
})
