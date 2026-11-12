import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRequestId } from '../../shared/detected-worktree-provider-contract'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { getSshProviderAuthority } from '../ssh/connection/authority/ssh-provider-authority'
import { listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, ipcEvent, setupWorktreeHandlers, store } from './worktrees-test-harness'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git/worktrees/git-worktree-porcelain-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseWorktreeList: (await import('./worktrees-test-module-mocks')).parseWorktreeListMock
}))

vi.mock('../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await import('./worktrees-test-module-mocks'))
    .assertWorktreeCleanForRemovalMock
}))

vi.mock('../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await import('./worktrees-test-module-mocks')).addWorktreeMock
}))

vi.mock('../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await import('./worktrees-test-module-mocks')).addSparseWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await import('./worktrees-test-module-mocks')).removeWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await import('./worktrees-test-module-mocks')).forceDeleteLocalBranchMock
}))
vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
  describeCreatedWorktree: (await import('./worktrees-test-module-mocks'))
    .describeCreatedWorktreeMock
}))
const { getWorktreeRunnerMocks } = vi.hoisted(() => {
  function createWorktreeRunnerMocks() {
    return (async () => (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock())()
  }
  let runner: ReturnType<typeof createWorktreeRunnerMocks> | undefined
  return { getWorktreeRunnerMocks: () => (runner ??= createWorktreeRunnerMocks()) }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: (await getWorktreeRunnerMocks()).gitExecFileAsync
}))

vi.mock('../git/command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: (await getWorktreeRunnerMocks()).gitExecFileSync
}))
vi.mock('../git/remotes/repo-remote-queries', async () => ({
  getDefaultRemote: (await import('./worktrees-test-module-mocks')).getDefaultRemoteMock
}))
vi.mock('../git/refs/resolution/repo-branch-conflict', async () =>
  (await import('./worktrees-test-module-mocks')).gitBranchConflictModuleMock()
)

vi.mock('../git/refs/resolution/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultBaseRefAsync: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock,
  resolveDefaultBaseRefWithLocalGit: (await import('./worktrees-test-module-mocks'))
    .resolveDefaultBaseRefWithLocalGitMock
}))
vi.mock('../git/repositories/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../github/client/lookup/get-pr-for-branch', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)

vi.mock('../git/worktrees/content-paths/worktree-symlink-detection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findExistingWorktreeSymlinkPaths: (await import('./worktrees-test-module-mocks'))
    .findExistingWorktreeSymlinkPathsMock
}))
vi.mock('../workspace-hooks/hooks', async () =>
  (await import('./worktrees-test-module-mocks')).hooksModuleMock()
)
vi.mock('../workspace-hooks/setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../workspace-hooks/setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../pty/history/terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspaces/space-analysis/workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/workspaces/removal/worktree-teardown', async () =>
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

  // Runtime rows bypass local stale GC too, so only authoritative host scans retire them (#17776).

  // Runtime ownership plus a connectionId is contradictory; findExactRepoOwner must refuse it.

  it('fails closed for duplicate exact owners and ambiguous legacy repo IDs', async () => {
    const sshRepo = {
      id: 'shared-repo',
      path: '/remote/repo-a',
      displayName: 'remote repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    const duplicateSshRepo = { ...sshRepo, path: '/remote/repo-b' }
    const localRepo = { ...sshRepo, path: '/local/repo', connectionId: undefined }
    store.getRepos.mockReturnValue([sshRepo, duplicateSshRepo, localRepo])
    const expectedAuthority = getSshProviderAuthority('target-a')

    const qualified = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'shared-repo',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })
    const legacy = await handlers['worktrees:listDetected'](null, { repoId: 'shared-repo' })

    expect(qualified).toMatchObject({
      status: 'ambiguous-owner',
      providerRequestId: 'request-1',
      executionHostId: 'ssh:target-a'
    })
    expect(legacy).toEqual({
      repoId: 'shared-repo',
      authoritative: false,
      source: 'metadata-fallback',
      worktrees: []
    })
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects runtime hosts, wrong SSH targets, and missing authority', async () => {
    const requestId = 'request-1' as ProviderRequestId
    const expectedAuthority = getSshProviderAuthority('target-a')

    const runtimeResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: 'runtime:runtime-a'
    })
    const wrongTargetResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-b'),
      expectedAuthority
    })
    const missingAuthorityResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a')
    })
    const zeroOwnerResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-b',
        executionHostId: toSshExecutionHostId('target-a')
      }
    ])
    const wrongProviderOwnerResult = await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: requestId,
      repoId: 'repo-1',
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority
    })

    expect(runtimeResult).toMatchObject({ status: 'rejected' })
    expect(wrongTargetResult).toMatchObject({ status: 'rejected' })
    expect(missingAuthorityResult).toMatchObject({ status: 'rejected' })
    expect(zeroOwnerResult).toMatchObject({ status: 'ambiguous-owner' })
    expect(wrongProviderOwnerResult).toMatchObject({ status: 'rejected' })
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })
})
