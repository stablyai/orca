import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness, setPlatform } from './github-ipc-test-harness'

const {
  getPRForBranch: getPRForBranchMock,
  getIssue: getIssueMock,
  getWorkItem: getWorkItemMock,
  getWorkItemByOwnerRepo: getWorkItemByOwnerRepoMock,
  listIssues: listIssuesMock,
  listWorkItems: listWorkItemsMock,
  countWorkItems: countWorkItemsMock,
  createIssue: createIssueMock,
  updateIssue: updateIssueMock,
  addIssueComment: addIssueCommentMock,
  listLabels: listLabelsMock,
  listAssignableUsers: listAssignableUsersMock,
  getPRChecks: getPRChecksMock,
  getPRCheckDetails: getPRCheckDetailsMock,
  getPRComments: getPRCommentsMock,
  setPRCommentReaction: setPRCommentReactionMock,
  resolveReviewThread: resolveReviewThreadMock,
  setPRFileViewed: setPRFileViewedMock,
  addPRReviewComment: addPRReviewCommentMock,
  addPRReviewCommentReply: addPRReviewCommentReplyMock,
  updatePRTitle: updatePRTitleMock,
  mergePR: mergePRMock,
  setPRAutoMerge: setPRAutoMergeMock,
  updatePRState: updatePRStateMock,
  rerunPRChecks: rerunPRChecksMock,
  requestPRReviewers: requestPRReviewersMock,
  removePRReviewers: removePRReviewersMock
} = mocks.client
const { getWorkItemDetails: getWorkItemDetailsMock, getPRFileContents: getPRFileContentsMock } =
  mocks.workItemDetails
const { reportVisiblePRRefreshCandidates: reportVisiblePRRefreshCandidatesMock } = mocks.prRefresh

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('routes local WSL project GitHub issue and work-item IPC through project git options', async () => {
    setPlatform('win32')
    harness.projects = [
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: 'blue',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ]
    listIssuesMock.mockResolvedValue({ items: [] })
    listWorkItemsMock.mockResolvedValue({ items: [] })
    countWorkItemsMock.mockResolvedValue(0)
    getIssueMock.mockResolvedValue(null)
    createIssueMock.mockResolvedValue({ ok: true, number: 1, url: 'https://example.com/1' })
    updateIssueMock.mockResolvedValue({ ok: true })
    addIssueCommentMock.mockResolvedValue({ ok: true })
    listLabelsMock.mockResolvedValue([])
    listAssignableUsersMock.mockResolvedValue([])
    getPRForBranchMock.mockResolvedValue(null)
    registerGitHubHandlers(store as never, stats as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }

    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo',
      branch: 'feature/wsl'
    })
    await handlers['gh:reportVisiblePRRefreshCandidates'](
      { sender: { id: 7, once: vi.fn() } },
      {
        generation: 1,
        candidates: [
          {
            cacheKey: '/workspace/repo::feature/wsl',
            repoPath: '/workspace/repo',
            branch: 'feature/wsl',
            repoKind: 'git',
            repoId: 'repo-1'
          }
        ]
      }
    )
    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: 'is:open',
      page: 2,
      noCache: true
    })
    await handlers['gh:countWorkItems'](null, {
      repoPath: '/workspace/repo',
      query: 'is:issue'
    })
    await handlers['gh:listIssues'](null, { repoPath: '/workspace/repo', limit: 5 })
    await handlers['gh:issue'](null, { repoPath: '/workspace/repo', number: 7 })
    await handlers['gh:createIssue'](null, {
      repoPath: '/workspace/repo',
      title: 'Title',
      body: 'Body',
      labels: ['bug']
    })
    await handlers['gh:updateIssue'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        number: 7,
        updates: { body: 'Updated' }
      }
    )
    await handlers['gh:addIssueComment'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        number: 7,
        body: 'Comment'
      }
    )
    await handlers['gh:listLabels'](null, { repoPath: '/workspace/repo' })
    await handlers['gh:listAssignableUsers'](null, { repoPath: '/workspace/repo' })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/wsl',
      null,
      null,
      null,
      { localGitExecOptions: localGitOptions }
    )
    expect(reportVisiblePRRefreshCandidatesMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          repoPath: '/workspace/repo',
          repoId: 'repo-1',
          localGitOptions
        })
      ],
      1,
      7
    )
    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      'is:open',
      2,
      undefined,
      null,
      true,
      localGitOptions
    )
    expect(countWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'is:issue',
      undefined,
      null,
      localGitOptions
    )
    expect(listIssuesMock).toHaveBeenCalledWith(
      '/workspace/repo',
      5,
      undefined,
      null,
      localGitOptions
    )
    expect(getIssueMock).toHaveBeenCalledWith('/workspace/repo', 7, null, localGitOptions)
    expect(createIssueMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'Title',
      'Body',
      undefined,
      null,
      { labels: ['bug'], assignees: undefined },
      localGitOptions
    )
    expect(updateIssueMock).toHaveBeenCalledWith(
      '/workspace/repo',
      7,
      { body: 'Updated' },
      null,
      localGitOptions
    )
    expect(addIssueCommentMock).toHaveBeenCalledWith(
      '/workspace/repo',
      7,
      'Comment',
      null,
      null,
      localGitOptions
    )
    expect(listLabelsMock).toHaveBeenCalledWith('/workspace/repo', undefined, null, localGitOptions)
    expect(listAssignableUsersMock).toHaveBeenCalledWith(
      '/workspace/repo',
      undefined,
      null,
      localGitOptions
    )
  })

  it('routes local WSL project GitHub PR detail and action IPC through project git options', async () => {
    setPlatform('win32')
    harness.projects = [
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: 'blue',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ]
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme-corp.com' }
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getWorkItemMock.mockResolvedValue(null)
    getWorkItemByOwnerRepoMock.mockResolvedValue(null)
    getWorkItemDetailsMock.mockResolvedValue(null)
    getPRFileContentsMock.mockResolvedValue({ original: '', modified: '' })
    getPRChecksMock.mockResolvedValue([])
    getPRCheckDetailsMock.mockResolvedValue(null)
    getPRCommentsMock.mockResolvedValue([])
    setPRCommentReactionMock.mockResolvedValue(true)
    resolveReviewThreadMock.mockResolvedValue(true)
    setPRFileViewedMock.mockResolvedValue(true)
    addPRReviewCommentReplyMock.mockResolvedValue({ ok: true })
    addPRReviewCommentMock.mockResolvedValue({ ok: true })
    updatePRTitleMock.mockResolvedValue(true)
    mergePRMock.mockResolvedValue({ ok: true })
    setPRAutoMergeMock.mockResolvedValue({ ok: true })
    updatePRStateMock.mockResolvedValue({ ok: true })
    rerunPRChecksMock.mockResolvedValue({ ok: true, count: 1 })
    requestPRReviewersMock.mockResolvedValue({ ok: true })
    removePRReviewersMock.mockResolvedValue({ ok: true })
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:workItem'](null, { repoPath: '/workspace/repo', number: 42, type: 'pr' })
    await handlers['gh:workItemByOwnerRepo'](null, {
      repoPath: '/workspace/repo',
      owner: 'acme',
      repo: 'orca',
      host: prRepo.host,
      number: 42,
      type: 'pr'
    })
    await handlers['gh:workItemDetails'](null, {
      repoPath: '/workspace/repo',
      number: 42,
      type: 'pr'
    })
    await handlers['gh:prFileContents'](null, {
      repoPath: '/workspace/repo',
      prNumber: 42,
      prRepo,
      path: 'src/app.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })
    await handlers['gh:prChecks'](null, {
      repoPath: '/workspace/repo',
      prNumber: 42,
      headSha: 'head-sha',
      prRepo,
      noCache: true
    })
    await handlers['gh:prCheckDetails'](null, {
      repoPath: '/workspace/repo',
      checkRunId: 9,
      workflowRunId: 8,
      checkName: 'lint',
      url: 'https://example.com/check',
      prRepo
    })
    await handlers['gh:prComments'](null, {
      repoPath: '/workspace/repo',
      prNumber: 42,
      prRepo,
      noCache: true
    })
    await handlers['gh:setPRCommentReaction'](null, {
      repoPath: '/workspace/repo',
      reactionSubjectId: ' IC_1 ',
      content: '+1',
      reacted: true,
      prRepo
    })
    await handlers['gh:resolveReviewThread'](null, {
      repoPath: '/workspace/repo',
      threadId: 'thread-1',
      resolve: true,
      prRepo
    })
    await handlers['gh:setPRFileViewed'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        prRepo,
        pullRequestId: 'PR_kw',
        path: 'src/app.ts',
        viewed: true
      }
    )
    await handlers['gh:addPRReviewCommentReply'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        prRepo,
        commentId: 11,
        body: ' Reply ',
        threadId: 'thread-1',
        path: 'src/app.ts',
        line: 10
      }
    )
    await handlers['gh:addPRReviewComment'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        prRepo,
        commitId: ' head-sha ',
        path: 'src/app.ts',
        line: 10,
        body: ' Inline '
      }
    )
    await handlers['gh:updatePRTitle'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        title: 'New title',
        prRepo
      }
    )
    await handlers['gh:mergePR'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        method: 'squash',
        prRepo
      }
    )
    await handlers['gh:setPRAutoMerge'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        enabled: true,
        method: 'squash',
        prRepo
      }
    )
    await handlers['gh:updatePRState'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        updates: { state: 'closed' },
        prRepo
      }
    )
    await handlers['gh:rerunPRChecks'](null, {
      repoPath: '/workspace/repo',
      prNumber: 42,
      headSha: 'head-sha',
      failedOnly: true,
      prRepo
    })
    await handlers['gh:requestPRReviewers'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        reviewers: ['octo'],
        prRepo
      }
    )
    await handlers['gh:removePRReviewers'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        reviewers: ['octo'],
        prRepo
      }
    )

    expect(getWorkItemMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      '/workspace/repo',
      prRepo,
      42,
      'pr',
      null,
      localGitOptions
    )
    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      localGitOptions,
      undefined
    )
    expect(getPRFileContentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/workspace/repo', localGitOptions, prRepo })
    )
    expect(getPRChecksMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'head-sha',
      prRepo,
      { noCache: true },
      null,
      localGitOptions
    )
    expect(getPRCheckDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      {
        checkRunId: 9,
        workflowRunId: 8,
        checkName: 'lint',
        url: 'https://example.com/check',
        prRepo
      },
      null,
      localGitOptions
    )
    expect(getPRCommentsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      { noCache: true, prRepo },
      null,
      localGitOptions
    )
    expect(setPRCommentReactionMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'IC_1',
      '+1',
      true,
      null,
      prRepo,
      localGitOptions
    )
    expect(resolveReviewThreadMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'thread-1',
      true,
      null,
      prRepo,
      localGitOptions
    )
    expect(setPRFileViewedMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/workspace/repo', localGitOptions, prRepo })
    )
    expect(addPRReviewCommentReplyMock).toHaveBeenCalledWith(
      '/workspace/repo',
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
    expect(addPRReviewCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/workspace/repo',
        commitId: 'head-sha',
        body: 'Inline',
        prRepo,
        localGitOptions
      })
    )
    expect(updatePRTitleMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'New title',
      null,
      prRepo,
      localGitOptions
    )
    expect(mergePRMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(setPRAutoMergeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      true,
      'squash',
      null,
      prRepo,
      localGitOptions
    )
    expect(updatePRStateMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      { state: 'closed' },
      null,
      prRepo,
      localGitOptions
    )
    expect(rerunPRChecksMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      { headSha: 'head-sha', failedOnly: true, prRepo },
      null,
      localGitOptions
    )
    expect(requestPRReviewersMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
    expect(removePRReviewersMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      ['octo'],
      null,
      prRepo,
      localGitOptions
    )
  })
})
