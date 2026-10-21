import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import { listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'

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
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
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

  it('hydrates detected worktrees with instance-validated legacy lineage after an update', async () => {
    const parentPath = '/workspace/assigned-issues'
    const childPath = '/workspace/issue-9276-nested-ssh-runtime-routing'
    const parentId = `repo-1::${parentPath}`
    const childId = `repo-1::${childPath}`
    const metaById: Record<string, { instanceId: string }> = {
      [parentId]: { instanceId: 'parent-instance' },
      [childId]: { instanceId: 'child-instance' }
    }
    store.getWorktreeMeta.mockImplementation((id: string) => metaById[id])
    store.setWorktreeMeta.mockImplementation(
      ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => ({
        ...metaById[id],
        ...updates
      })
    )
    store.getAllWorktreeLineage.mockReturnValue({
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: childPath,
        head: 'child-head',
        branch: 'refs/heads/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: parentPath,
        head: 'parent-head',
        branch: 'refs/heads/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: (Worktree & { lineage?: unknown; parentWorktreeId?: string | null })[] }

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
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder' as const
    }
    const parentId = `${folderRepo.id}::${folderRepo.path}`
    const childId = `${parentId}::workspace:child-instance`
    const metaById: Record<string, Record<string, unknown>> = {
      [parentId]: makeWorktreeMeta({
        instanceId: 'parent-instance',
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      }),
      [childId]: makeWorktreeMeta({
        instanceId: 'child-instance',
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1'
      })
    }
    store.getRepos.mockReturnValue([folderRepo])
    store.getRepo.mockReturnValue(folderRepo)
    store.getAllWorktreeMeta.mockReturnValue(metaById)
    store.getWorktreeMeta.mockImplementation((worktreeId: string) => metaById[worktreeId])
    store.getAllWorktreeLineage.mockReturnValue({
      [childId]: {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    })

    const result = (await handlers['worktrees:listDetected'](null, {
      repoId: folderRepo.id
    })) as { worktrees: (Worktree & { lineage?: unknown; parentWorktreeId?: string | null })[] }

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

  it('hides agent scratch created inside a linked checkout from desktop listings', async () => {
    const linkedCheckoutPath = '/workspace/feature-x'
    const scratchPath = `${linkedCheckoutPath}/.claude/worktrees/agent-a04ccaaa`
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedCheckoutPath,
        head: 'feature-head',
        branch: 'refs/heads/feature-x',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: scratchPath,
        head: 'scratch-head',
        branch: 'refs/heads/worktree-agent-a04ccaaa',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const detected = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: (Worktree & { ownership: string; visible: boolean })[] }
    const visible = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as Worktree[]

    expect(detected.worktrees.find((worktree) => worktree.path === scratchPath)).toMatchObject({
      ownership: 'agent-scratch',
      visible: false
    })
    expect(visible.map((worktree) => worktree.path)).toEqual([
      '/workspace/repo',
      linkedCheckoutPath
    ])
  })

  it('does not repeatedly rotate already-invalid missing parent metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    store.getRepos.mockReturnValue([repo])
    // Why: this process serves no SSH git, so the SSH repo lists its stored rows.
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-ssh::/remote/live-child': {}
    })
    store.getRepo.mockReturnValue(repo)
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-ssh::/remote/live-child': {
        parentWorktreeId: 'repo-ssh::/remote/missing-parent',
        parentWorktreeInstanceId: 'old-parent-instance'
      }
    })
    store.getWorktreeMeta.mockReturnValue({ instanceId: 'rotated-parent-instance' })

    await handlers['worktrees:list'](null, { repoId: 'repo-ssh' })

    expect(store.setWorktreeMeta).not.toHaveBeenCalledWith(
      hostWorktreeTarget({ id: 'repo-ssh::/remote/missing-parent', hostId: 'local' }),
      expect.objectContaining({ instanceId: expect.any(String) })
    )
  })
})
