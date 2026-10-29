import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta, expectDetectedWorktreeListResult } from './worktrees-test-fixtures'
import { buildDetectedGitWorktrees } from './worktrees/listing/ssh-worktree-fallback'
import type { Store } from '../persistence/loading-store/store'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { DetectedWorktree } from '../../shared/worktree/types'

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

async function listDetectedRows(repoId: string): Promise<DetectedWorktree[]> {
  const result = expectDetectedWorktreeListResult(
    await handlers['worktrees:listDetected'](null, {
      repoId
    })
  )
  return result.worktrees
}

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

    const listed = await listDetectedRows('repo-1')

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
    store.getRepos.mockReturnValue([repo])
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

    const listed = await listDetectedRows('repo-ssh')

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
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-ssh::/remote/feature-wt', hostId: 'ssh:conn-1' }),
      {
        projectId: 'repo:repo-ssh',
        hostId: 'ssh:conn-1',
        projectHostSetupId: 'repo-ssh'
      }
    )
  })

  it('lists a canonical-only SSH row without leaking the same-id local row', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const worktreeId = 'repo-ssh::/shared/feature-wt'
    const canonicalRemote = makeWorktreeMeta({
      displayName: 'Canonical remote',
      hostId: 'ssh:conn-1'
    })
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      [worktreeId]: makeWorktreeMeta({ displayName: 'Legacy local', hostId: 'local' })
    })
    ;(
      store as typeof store & {
        getAllWorktreeMetaForHost: ReturnType<typeof vi.fn>
      }
    ).getAllWorktreeMetaForHost = vi.fn(() => ({ [worktreeId]: canonicalRemote }))

    const listed = await listDetectedRows(repo.id)

    expect(listed).toEqual([
      expect.objectContaining({
        id: worktreeId,
        displayName: 'Canonical remote',
        hostId: 'ssh:conn-1'
      })
    ])
  })

  it('lists reconstructed SSH rows from persisted metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    })

    const listed = await listDetectedRows('repo-ssh')

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-ssh::/remote/feature-wt',
        displayName: 'Feature workspace',
        lastActivityAt: 42
      })
    ])
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
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'not-a-worktree-id': makeWorktreeMeta({ displayName: 'Bad row' }),
      'repo-ssh::/remote/feature-wt': makeWorktreeMeta({ displayName: 'Good row' })
    })

    const listed = await listDetectedRows('repo-ssh')

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
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/custom-name': makeWorktreeMeta({
        sparseDirectories: ['packages/web']
      })
    })

    const listed = await listDetectedRows('repo-ssh')

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
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::c:/remote/repo': makeWorktreeMeta()
    })

    const listed = await listDetectedRows('repo-ssh')

    expect(listed[0].isMainWorktree).toBe(true)
  })

  it('loads repo ownership once while building multiple detected rows', () => {
    const owner = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepos.mockReturnValue([owner])

    const detected = buildDetectedGitWorktrees(
      store as unknown as Store,
      owner,
      ['/workspace/one', '/workspace/two', '/workspace/three'].map((path) => ({
        path,
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      })),
      {}
    )

    expect(detected).toHaveLength(3)
    expect(store.getRepos).toHaveBeenCalledTimes(1)
  })
})
