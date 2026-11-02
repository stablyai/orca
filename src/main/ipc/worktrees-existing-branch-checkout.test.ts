import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  addWorktreeMock,
  getPRForBranchMock,
  computeWorktreePathMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

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
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it.each(['remote', 'local', 'busy'])('preserves explicit picker intent (%s)', async (kind) => {
    const branchName = 'fix/bug-0'
    const remoteTrackingBase = {
      remote: 'origin',
      branch: branchName,
      base: `origin/${branchName}`,
      ref: `refs/remotes/origin/${branchName}`
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteTrackingBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    gitExecFileAsyncMock.mockImplementation(async (argv) => {
      if (kind === 'remote' && argv.includes(`refs/heads/${branchName}^{commit}`)) {
        throw Object.assign(new Error('missing'), { code: 1 })
      }
      if (argv[0] === 'for-each-ref') {
        return { stdout: `refs/heads/${branchName}\n`, stderr: '' }
      }
      return { stdout: 'local-ahead', stderr: '' }
    })
    const mainWorktree = {
      path: '/workspace/repo',
      head: 'main',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    }
    computeWorktreePathMock.mockImplementation((name: string) =>
      name === 'fix-bug-0' ? process.cwd() : `/workspace/${name}`
    )
    const created = {
      path: '/workspace/fix-bug-0-2',
      head: 'local-ahead',
      branch: `refs/heads/${branchName}`,
      isBare: false,
      isMainWorktree: false
    }
    listWorktreesMock.mockResolvedValue([mainWorktree, created])
    if (kind === 'local') {
      listWorktreesMock.mockResolvedValueOnce([mainWorktree])
    } else if (kind === 'remote') {
      addWorktreeMock.mockResolvedValueOnce({ upstreamWarning: 'Check the push destination.' })
    } else if (kind === 'busy') {
      listWorktreesMock.mockResolvedValueOnce([{ ...created, path: '/workspace/busy' }])
    }
    const creation = handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix/bug-0',
      baseBranch: remoteTrackingBase.base,
      branchNameOverride: branchName,
      branchIntent: 'open-existing-v2'
    })
    if (kind === 'busy') {
      await expect(creation).rejects.toThrow('already checked out at "/workspace/busy"')
      expect(addWorktreeMock).not.toHaveBeenCalled()
      return
    }
    const result = await creation
    if (kind === 'remote') {
      expect(result).toMatchObject({ warning: 'Check the push destination.' })
    }
    expect(getPRForBranchMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledExactlyOnceWith(
      '/workspace/repo',
      '/workspace/fix-bug-0-2',
      branchName,
      remoteTrackingBase.base,
      false,
      false,
      expect.objectContaining(
        kind === 'local' ? { checkoutExistingBranch: true } : { trackRemoteBranch: true }
      )
    )
    expect(result).toMatchObject({ worktree: { branch: `refs/heads/${branchName}` } })
  })
})
