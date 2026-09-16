import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  OrcaRuntimeService,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getBaseRefDefault,
  getGitHubPRCheckDetailsMock,
  getGitHubPRChecksMock,
  getGitHubPRCommentsMock,
  getGitHubPRFileContentsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchOutcomeMock,
  listWorktrees,
  mergeGitHubPRMock,
  registerSshGitProvider,
  removeGitHubPRReviewersMock,
  requestGitHubPRReviewersMock,
  rerunGitHubPRChecksMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRAutoMergeMock,
  setGitHubPRFileViewedMock,
  setPlatform,
  unregisterSshGitProvider,
  updateGitHubPRDetailsMock,
  updateGitHubPRStateMock,
  updateGitHubPRTitleMock
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('routes runtime GitHub PR details and actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme.test' }
    const checkDetailsSignal = new AbortController().signal

    await runtime.getRepoPRForBranch('id:repo-1', 'feature/wsl', 42, 43)
    await runtime.getRepoPRForBranch(
      'id:repo-1',
      'feature/wsl-manual',
      42,
      43,
      undefined,
      undefined,
      'manual'
    )
    await runtime.getRepoPRForBranch(
      'id:repo-1',
      'feature/wsl-active',
      42,
      43,
      undefined,
      undefined,
      'active'
    )
    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoPRChecks('id:repo-1', 42, 'head-sha', prRepo, { noCache: true })
    await runtime.rerunRepoPRChecks('id:repo-1', 42, {
      headSha: 'head-sha',
      failedOnly: true,
      prRepo
    })
    await runtime.getRepoPRCheckDetails(
      'id:repo-1',
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      checkDetailsSignal
    )
    await runtime.getRepoPRComments('id:repo-1', 42, prRepo, { noCache: true })
    await runtime.getRepoPRFileContents('id:repo-1', {
      prNumber: 42,
      prRepo,
      path: 'src/app.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })
    await runtime.resolveRepoReviewThread('id:repo-1', 'thread-1', true, prRepo)
    await runtime.setRepoPRFileViewed('id:repo-1', {
      prRepo,
      pullRequestId: 'PR_kw',
      path: 'src/app.ts',
      viewed: true
    })
    await runtime.updateRepoPRTitle('id:repo-1', 42, 'New title', prRepo)
    await runtime.updateRepoPRDetails('id:repo-1', 42, { body: 'New body' }, prRepo)
    await runtime.mergeRepoPR('id:repo-1', 42, 'squash', prRepo)
    await runtime.setRepoPRAutoMerge('id:repo-1', 42, true, 'squash', prRepo)
    await runtime.updateRepoPRState('id:repo-1', 42, { state: 'closed' }, prRepo)
    await runtime.requestRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.removeRepoPRReviewers('id:repo-1', 42, ['octo'], prRepo)
    await runtime.addRepoPRReviewComment('id:repo-1', {
      prNumber: 42,
      prRepo,
      body: 'Inline',
      commitId: 'head-sha',
      path: 'src/app.ts',
      line: 10
    })
    await runtime.addRepoPRReviewCommentReply('id:repo-1', {
      prNumber: 42,
      commentId: 11,
      body: 'Reply',
      threadId: 'thread-1',
      path: 'src/app.ts',
      line: 10,
      prRepo
    })

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/wsl',
      42,
      null,
      null,
      {
        localGitExecOptions: localGitOptions
      }
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/wsl-manual',
      42,
      null,
      null,
      { localGitExecOptions: { ...localGitOptions, admissionTier: 'interactive' } }
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/wsl-active',
      42,
      null,
      null,
      { localGitExecOptions: { ...localGitOptions, admissionTier: 'background' } }
    )
    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null,
      localGitOptions
    )
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'head-sha',
      prRepo,
      { noCache: true },
      null,
      localGitOptions
    )
    expect(rerunGitHubPRChecksMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { headSha: 'head-sha', failedOnly: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      null,
      localGitOptions,
      checkDetailsSignal
    )
    expect(getGitHubPRCommentsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { noCache: true, prRepo },
      null,
      localGitOptions
    )
    expect(getGitHubPRFileContentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(resolveGitHubReviewThreadMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'thread-1',
      true,
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRFileViewedMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: TEST_REPO_PATH, localGitOptions, prRepo })
    )
    expect(updateGitHubPRTitleMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'New title',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { body: 'New body' },
      null,
      prRepo,
      localGitOptions
    )
    expect(mergeGitHubPRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(setGitHubPRAutoMergeMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      true,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(updateGitHubPRStateMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      { state: 'closed' },
      null,
      prRepo,
      localGitOptions
    )
    expect(requestGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(removeGitHubPRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(addGitHubPRReviewCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        localGitOptions,
        prRepo,
        body: 'Inline'
      })
    )
    expect(addGitHubPRReviewCommentReplyMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      11,
      'Reply',
      'thread-1',
      'src/app.ts',
      10,
      null,
      prRepo,
      localGitOptions
    )
  })

  it('rejects hosted review worktree selectors outside the selected repo', async () => {
    vi.mocked(listWorktrees).mockImplementation(async (repoPath: string) => {
      if (repoPath === '/tmp/repo-b') {
        return [
          {
            path: '/tmp/worktree-b',
            head: 'def',
            branch: 'feature/bar',
            isBare: false,
            isMainWorktree: false
          }
        ]
      }
      return MOCK_GIT_WORKTREES
    })
    const repos = [
      {
        id: TEST_REPO_ID,
        path: TEST_REPO_PATH,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: 'repo-2',
        path: '/tmp/repo-b',
        displayName: 'repo-b',
        badgeColor: 'green',
        addedAt: 2
      }
    ]
    const multiRepoStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id)
    }
    const runtime = new OrcaRuntimeService(multiRepoStore as never)

    await expect(
      runtime.getHostedReviewCreationEligibility({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        branch: 'feature/bar',
        base: 'main',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 0
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')
    await expect(
      runtime.createHostedReview({
        repoSelector: 'id:repo-1',
        worktreeSelector: 'id:repo-2::/tmp/worktree-b',
        provider: 'github',
        base: 'main',
        head: 'feature/bar',
        title: 'Create PR',
        body: '',
        draft: false
      })
    ).rejects.toThrow('Access denied: worktree does not belong to repository')

    expect(getHostedReviewCreationEligibilityMock).not.toHaveBeenCalled()
    expect(createHostedReviewMock).not.toHaveBeenCalled()
  })

  it('passes SSH connection context through hosted review creation flows', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/ssh',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/ssh',
      title: 'Feature SSH',
      body: '',
      draft: false
    })
    await runtime.createStackedHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'stack/parent',
      head: 'feature/ssh',
      title: 'Feature SSH',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/remote/repo',
        executionHostId: 'ssh:ssh-1',
        branch: 'feature/ssh'
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      '/remote/repo',
      expect.objectContaining({
        provider: 'github',
        head: 'feature/ssh',
        title: 'Feature SSH'
      }),
      'ssh:ssh-1',
      { localGitExecOptions: { admissionTier: 'interactive' } }
    )
    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      '/remote/repo',
      expect.objectContaining({
        provider: 'github',
        base: 'stack/parent',
        head: 'feature/ssh'
      }),
      'ssh:ssh-1',
      { localGitExecOptions: { admissionTier: 'interactive' } }
    )
  })

  it('routes local WSL project hosted review flows through runtime git options', async () => {
    setPlatform('win32')
    const wslStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(wslStore as never)
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'github',
      number: 76,
      title: 'Feature WSL',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/76',
      status: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })
    createHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 77,
      url: 'https://github.com/acme/orca/pull/77'
    })

    await runtime.getHostedReviewForBranch({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      linkedGitHubPR: 76
    })
    await runtime.getHostedReviewCreationEligibility({
      repoSelector: `id:${TEST_REPO_ID}`,
      branch: 'feature/wsl',
      base: 'main',
      hasUncommittedChanges: false,
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await runtime.createHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'main',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })
    await runtime.createStackedHostedReview({
      repoSelector: `id:${TEST_REPO_ID}`,
      provider: 'github',
      base: 'stack/parent',
      head: 'feature/wsl',
      title: 'Feature WSL',
      body: '',
      draft: false
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        executionHostId: 'local',
        branch: 'feature/wsl',
        localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' }
      })
    )
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: TEST_REPO_PATH,
        executionHostId: 'local',
        branch: 'feature/wsl',
        linkedGitHubPR: 76,
        localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'background' }
      })
    )
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        head: 'feature/wsl',
        title: 'Feature WSL'
      }),
      'local',
      { localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' } }
    )
    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      expect.objectContaining({
        provider: 'github',
        base: 'stack/parent',
        head: 'feature/wsl'
      }),
      'local',
      { localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' } }
    )
  })

  it('treats SSH worktree drift as unknown without local git probes', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(getBaseRefDefault).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getWorktreeMeta: () => null
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.probeWorktreeDrift('path:/remote/repo')).resolves.toBeNull()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.listWorktrees).toHaveBeenCalledWith('/remote/repo')
    expect(getBaseRefDefault).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })
})
