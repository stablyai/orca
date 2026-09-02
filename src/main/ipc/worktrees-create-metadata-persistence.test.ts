import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  getPullRequestPushTargetMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import {
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  makeWorktreeMeta
} from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

const WORKTREE_HANDLER_CHANNELS = [
  'worktrees:listAll',
  'worktrees:list',
  'worktrees:listRetiredNames',
  'worktrees:listDetected',
  'worktrees:listKnownForExecutionHost',
  'worktrees:forgetRemovedForExecutionHost',
  'worktrees:cancelListDetected',
  'worktrees:create',
  'worktrees:adoptProvisionedRoot',
  'worktrees:prefetchCreateBase',
  'worktrees:resolvePrBase',
  'worktrees:resolveMrBase',
  'worktrees:remove',
  'worktrees:forgetLocal',
  'worktrees:forceDeletePreservedBranch',
  'worktrees:updateMeta',
  'worktrees:listLineage',
  'worktrees:listLineageForHost',
  'worktrees:updateLineage',
  'worktrees:persistSortOrder',
  'worktrees:getBranchRenameFailureOutput',
  'hooks:check',
  'hooks:inspectSetupScriptImports',
  'hooks:createIssueCommandRunner',
  'hooks:readIssueCommand',
  'hooks:writeIssueCommand'
] as const

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
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
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
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('clears the GitLab MR base handler before re-registering IPC handlers', () => {
    expect(removeHandlerMock).toHaveBeenCalledWith('worktrees:resolveMrBase')
    expect(handlers['worktrees:resolveMrBase']).toBeDefined()
  })

  it('clears the branch rename failure-output handler before re-registering IPC handlers', () => {
    expect(removeHandlerMock).toHaveBeenCalledWith('worktrees:getBranchRenameFailureOutput')
    expect(handlers['worktrees:getBranchRenameFailureOutput']).toBeDefined()
  })

  it('removes exactly the installed channel set before installing the first handler', () => {
    const removedChannels = removeHandlerMock.mock.calls.map(([channel]) => channel)
    const installedChannels = handleMock.mock.calls.map(([channel]) => channel)

    expect(new Set(removedChannels)).toEqual(new Set(WORKTREE_HANDLER_CHANNELS))
    expect(new Set(removedChannels)).toEqual(new Set(installedChannels))
    expect(new Set(installedChannels)).toEqual(new Set(WORKTREE_HANDLER_CHANNELS))
    expect(removedChannels).toHaveLength(WORKTREE_HANDLER_CHANNELS.length)
    expect(installedChannels).toHaveLength(WORKTREE_HANDLER_CHANNELS.length)
    expect(Math.max(...removeHandlerMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...handleMock.mock.invocationCallOrder)
    )
  })

  it('persistSortOrder only reorders existing worktrees and never mints meta for a stale id', () => {
    const liveId = 'repo-1::/workspace/repo'
    const staleId = 'removed-repo::/workspace/gone'
    // Only the live worktree has meta; the stale id (e.g. a removed repo the
    // renderer still lists) has none and must be skipped, not created.
    store.getWorktreeMeta.mockImplementation((id: string) =>
      id === liveId ? ({ instanceId: 'x' } as never) : undefined
    )

    handlers['worktrees:persistSortOrder'](null, { orderedIds: [liveId, staleId] })

    const orderedTargets = store.setWorktreeMeta.mock.calls.map((call) => call[0])
    expect(orderedTargets).toContain(liveId)
    expect(orderedTargets).not.toContain(staleId)
  })

  it('persistSortOrder skips ranks that already represent the requested order', () => {
    const firstId = 'repo-1::/workspace/first'
    const secondId = 'repo-1::/workspace/second'
    store.getWorktreeMeta.mockImplementation((id: string) => ({
      sortOrder: id === firstId ? 200 : 100
    }))

    handlers['worktrees:persistSortOrder'](null, { orderedIds: [firstId, secondId] })

    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('strips Orca provenance fields from renderer metadata updates', () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      updates: {
        comment: 'keep me',
        isPinned: true,
        orcaCreatedAt: 123,
        orcaCreationSource: 'desktop',
        orcaCreationWorkspaceLayout: { path: '/workspace', nestWorkspaces: false }
      }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/feature-wt', {
      comment: 'keep me',
      isPinned: true
    })
    expect(result).toMatchObject({ comment: 'keep me', isPinned: true })
  })
  it('routes metadata updates through the explicitly selected host', () => {
    store.setWorktreeMetaForHost.mockImplementation((_worktreeId, _executionHostId, meta) => meta)

    const result = handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      executionHostId: 'ssh:build-box',
      updates: { comment: 'remote note' }
    })

    expect(store.setWorktreeMetaForHost).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      'ssh:build-box',
      { comment: 'remote note' }
    )
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(result).toMatchObject({ comment: 'remote note' })
  })

  it('rejects malformed execution-host identities at the IPC boundary', () => {
    expect(() =>
      handlers['worktrees:updateMeta'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        executionHostId: 'container:untrusted',
        updates: { comment: 'must not write' }
      })
    ).toThrow('Invalid execution host identity.')

    expect(store.setWorktreeMetaForHost).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('pushes a remote-client invalidation for renames but not read-state updates', () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      updates: { isUnread: false }
    })
    // Why: per-click isUnread writes must stay event-free (PR #209), while a rename must reach paired remote clients that no longer poll for titles.
    expect(runtimeStub.notifyWorktreesChangedForRemoteClients).not.toHaveBeenCalled()

    handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      updates: { displayName: 'Renamed workspace' }
    })
    expect(runtimeStub.notifyWorktreesChangedForRemoteClients).toHaveBeenCalledWith('repo-1')
  })

  it('persists display-name provenance at the host boundary', () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    handlers['worktrees:updateMeta'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      updates: { displayName: 'Agent label' }
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/feature-wt',
      expect.objectContaining({ displayName: 'Agent label', displayNameIsPinned: true })
    )
  })

  it('does not trust renderer-authored automation provenance during local create', async () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'automation-1',
        automationNameSnapshot: 'Forged',
        automationRunId: 'run-1',
        automationRunTitleSnapshot: 'Forged run',
        createdAt: 123,
        executionTargetType: 'local',
        executionTargetId: 'local',
        projectId: 'repo-1'
      }
    })

    const persistedMeta = store.setWorktreeMeta.mock.calls.find(
      ([worktreeId]) => worktreeId === 'repo-1::/workspace/improve-dashboard'
    )?.[1]
    expect(persistedMeta).toBeDefined()
    expect(persistedMeta).not.toHaveProperty('automationProvenance')
  })

  it('persists a sanitized artifact title as the worktree display name', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      displayName: '  Fix: dashboards\nfor PRs\u0000  '
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        displayName: 'Fix: dashboards for PRs'
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        displayName: 'Fix: dashboards for PRs'
      })
    })
  })

  it('pins a legacy name-only user create when the branch matches', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature'
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/feature',
      expect.objectContaining({ displayName: 'feature', displayNameIsPinned: true })
    )
  })

  it('persists linked issue and PR metadata during local create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      linkedIssue: 123,
      linkedPR: 456,
      linkedLinearIssue: 'ENG-123',
      manualOrder: 123_456
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    })
  })

  it('persists the selected creation agent during local create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'codex'
    })

    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        createdWithAgent: 'codex'
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        createdWithAgent: 'codex'
      })
    })
  })

  // Was "configures a PR push target during local create": create used to mint the
  // fork remote up front. It now defers to first sync (#17828); the minting itself is
  // covered by worktree-remote-push-target-materialization.test.ts.
  it('defers the fork-PR remote during local create and persists the target unmaterialized', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      [
        'remote',
        'add',
        '-t',
        'prateek/fix-sidebar-agents-toggle',
        '--no-tags',
        'pr-prateek-orca',
        'git@github.com:prateek/orca.git'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      [
        'fetch',
        'pr-prateek-orca',
        '+refs/heads/prateek/fix-sidebar-agents-toggle*:refs/remotes/pr-prateek-orca/prateek/fix-sidebar-agents-toggle*'
      ],
      { cwd: '/workspace/repo' }
    )
    // Upstream can only be set once the remote exists, so it defers with the remote.
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      [
        'branch',
        '--set-upstream-to',
        'pr-prateek-orca/prateek/fix-sidebar-agents-toggle',
        'improve-dashboard'
      ],
      { cwd: '/workspace/improve-dashboard' }
    )
    // Exact object, not objectContaining: `remoteCreated` must stay absent until
    // something actually mints the remote.
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-prateek-orca',
          branchName: 'prateek/fix-sidebar-agents-toggle',
          remoteUrl: 'git@github.com:prateek/orca.git'
        }
      })
    )
  })

  // Was "keeps the Orca-created marker ...": create used to inherit the marker while
  // minting. With minting deferred (#17828) create must not claim ownership it has not
  // earned; marker inheritance now happens at materialization and is covered by
  // worktree-push-target-setup.test.ts.
  it('does not claim the Orca-created marker at create when a sibling worktree minted the fork remote', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const existingPushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/previous-fix',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/previous-fix': makeWorktreeMeta({ pushTarget: existingPushTarget })
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'pr-contributor-orca\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/new-fix',
        remoteUrl: 'https://github.com/contributor/orca.git'
      }
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'add', expect.any(String), expect.any(String)],
      expect.any(Object)
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/new-fix',
          remoteUrl: 'https://github.com/contributor/orca.git'
        }
      })
    )
  })

  it('threads explicit origin preference into dual-remote PR head resolution', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      issueSourcePreference: 'origin',
      worktreeBaseRef: null
    })
    getPullRequestPushTargetMock.mockResolvedValue({
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const url =
          args[2] === 'origin' ? ORIGIN_REMOTE_URL : 'git@github.com:org/upstream-repo.git'
        return { stdout: `${url}\n`, stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1738,
      headRefName: 'prateek/fix-sidebar-agents-toggle',
      isCrossRepository: true
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/pull/1738/head:refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/1738`
      ],
      { cwd: '/workspace/repo', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'get-url', 'upstream'],
      expect.anything()
    )
    expect(getPullRequestPushTargetMock).toHaveBeenCalledWith(
      '/workspace/repo',
      1738,
      null,
      {},
      'origin'
    )
    expect(result).toMatchObject({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'prateek/fix-sidebar-agents-toggle',
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })
  })

  it('returns the same-repo PR head SHA and exact branch override when resolving a PR base', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      isCrossRepository: false
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/add-feature'],
      { cwd: '/workspace/repo' }
    )
    expect(result).toMatchObject({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })
})
