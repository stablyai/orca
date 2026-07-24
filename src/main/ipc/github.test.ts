/* eslint-disable max-lines -- Why: GitHub IPC tests share one mocked Electron
handler harness; keeping the related route wiring together avoids duplicated setup. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_PLATFORM = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

const {
  handleMock,
  getPRForBranchMock,
  getIssueMock,
  getWorkItemMock,
  getWorkItemByOwnerRepoMock,
  getWorkItemDetailsMock,
  getPRFileContentsMock,
  getPRChecksMock,
  getPRCheckDetailsMock,
  getPRCommentsMock,
  resolveReviewThreadMock,
  setPRFileViewedMock,
  addPRReviewCommentMock,
  addPRReviewCommentReplyMock,
  updatePRTitleMock,
  listIssuesMock,
  listWorkItemsMock,
  countWorkItemsMock,
  createIssueMock,
  updateIssueMock,
  addIssueCommentMock,
  listLabelsMock,
  listAssignableUsersMock,
  getAuthenticatedViewerMock,
  mergePRMock,
  setPRAutoMergeMock,
  updatePRStateMock,
  rerunPRChecksMock,
  requestPRReviewersMock,
  removePRReviewersMock,
  checkOrcaStarredMock,
  starOrcaMock,
  trackMock,
  getCohortAtEmitMock,
  getAllWebContentsMock,
  sendToTrustedUIRendererMock,
  clearVisiblePRRefreshWindowMock,
  enqueuePRRefreshMock,
  refreshPRNowMock,
  reportVisiblePRRefreshCandidatesMock,
  setPRRefreshOutcomeObserverMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getIssueMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getWorkItemByOwnerRepoMock: vi.fn(),
  getWorkItemDetailsMock: vi.fn(),
  getPRFileContentsMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCheckDetailsMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  resolveReviewThreadMock: vi.fn(),
  setPRFileViewedMock: vi.fn(),
  addPRReviewCommentMock: vi.fn(),
  addPRReviewCommentReplyMock: vi.fn(),
  updatePRTitleMock: vi.fn(),
  listIssuesMock: vi.fn(),
  listWorkItemsMock: vi.fn(),
  countWorkItemsMock: vi.fn(),
  createIssueMock: vi.fn(),
  updateIssueMock: vi.fn(),
  addIssueCommentMock: vi.fn(),
  listLabelsMock: vi.fn(),
  listAssignableUsersMock: vi.fn(),
  getAuthenticatedViewerMock: vi.fn(),
  mergePRMock: vi.fn(),
  setPRAutoMergeMock: vi.fn(),
  updatePRStateMock: vi.fn(),
  rerunPRChecksMock: vi.fn(),
  requestPRReviewersMock: vi.fn(),
  removePRReviewersMock: vi.fn(),
  checkOrcaStarredMock: vi.fn(),
  starOrcaMock: vi.fn(),
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(),
  getAllWebContentsMock: vi.fn(),
  sendToTrustedUIRendererMock: vi.fn(),
  clearVisiblePRRefreshWindowMock: vi.fn(),
  enqueuePRRefreshMock: vi.fn(),
  refreshPRNowMock: vi.fn(),
  reportVisiblePRRefreshCandidatesMock: vi.fn(),
  setPRRefreshOutcomeObserverMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  webContents: {
    getAllWebContents: getAllWebContentsMock
  }
}))

vi.mock('../github/client', () => ({
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
  getAuthenticatedViewer: getAuthenticatedViewerMock,
  getPRChecks: getPRChecksMock,
  getPRCheckDetails: getPRCheckDetailsMock,
  getPRComments: getPRCommentsMock,
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
  removePRReviewers: removePRReviewersMock,
  checkOrcaStarred: checkOrcaStarredMock,
  starOrca: starOrcaMock
}))

vi.mock('../github/work-item-details', () => ({
  getWorkItemDetails: getWorkItemDetailsMock,
  getPRFileContents: getPRFileContentsMock
}))

vi.mock('../github/pr-refresh-coordinator', () => ({
  clearVisiblePRRefreshWindow: clearVisiblePRRefreshWindowMock,
  enqueuePRRefresh: enqueuePRRefreshMock,
  refreshPRNow: refreshPRNowMock,
  reportVisiblePRRefreshCandidates: reportVisiblePRRefreshCandidatesMock,
  setPRRefreshOutcomeObserver: setPRRefreshOutcomeObserverMock
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

vi.mock('./ui', () => ({
  sendToTrustedUIRenderer: sendToTrustedUIRendererMock
}))

import { registerGitHubHandlers } from './github'
import { clearPRRefreshValidationBackoffForTests } from '../github/pr-refresh-validation-backoff'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerGitHubHandlers', () => {
  const handlers: HandlerMap = {}
  type FixtureRepo = {
    id: string
    path: string
    displayName: string
    badgeColor: string
    addedAt: number
    connectionId?: string | null
    executionHostId?: string | null
    issueSourcePreference?: 'origin' | 'upstream'
  }
  let repos: FixtureRepo[] = []
  let projects: {
    id: string
    displayName: string
    badgeColor: string
    sourceRepoIds: string[]
    localWindowsRuntimePreference?: { kind: 'wsl'; distro: string }
    createdAt: number
    updatedAt: number
  }[] = []
  const store = {
    getRepos: () => repos,
    getProjects: () => projects,
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
  }
  const stats = {
    hasCountedPR: () => false,
    record: vi.fn()
  }

  beforeEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    handleMock.mockReset()
    getPRForBranchMock.mockReset()
    getIssueMock.mockReset()
    getWorkItemMock.mockReset()
    getWorkItemByOwnerRepoMock.mockReset()
    getWorkItemDetailsMock.mockReset()
    getPRFileContentsMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCheckDetailsMock.mockReset()
    getPRCommentsMock.mockReset()
    resolveReviewThreadMock.mockReset()
    setPRFileViewedMock.mockReset()
    addPRReviewCommentMock.mockReset()
    addPRReviewCommentReplyMock.mockReset()
    updatePRTitleMock.mockReset()
    listIssuesMock.mockReset()
    listWorkItemsMock.mockReset()
    countWorkItemsMock.mockReset()
    createIssueMock.mockReset()
    updateIssueMock.mockReset()
    addIssueCommentMock.mockReset()
    listLabelsMock.mockReset()
    listAssignableUsersMock.mockReset()
    getAuthenticatedViewerMock.mockReset()
    mergePRMock.mockReset()
    setPRAutoMergeMock.mockReset()
    updatePRStateMock.mockReset()
    rerunPRChecksMock.mockReset()
    requestPRReviewersMock.mockReset()
    removePRReviewersMock.mockReset()
    checkOrcaStarredMock.mockReset()
    starOrcaMock.mockReset()
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: undefined })
    getAllWebContentsMock.mockReset()
    getAllWebContentsMock.mockReturnValue([])
    sendToTrustedUIRendererMock.mockReset()
    clearVisiblePRRefreshWindowMock.mockReset()
    enqueuePRRefreshMock.mockReset()
    refreshPRNowMock.mockReset()
    reportVisiblePRRefreshCandidatesMock.mockReset()
    setPRRefreshOutcomeObserverMock.mockReset()
    clearPRRefreshValidationBackoffForTests()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    // Reset fixture repos to the default single-repo fixture each test, so
    // individual tests can mutate the list without leaking preferences across
    // tests (e.g. a preference-threading test could otherwise shadow the
    // default-undefined assertions in sibling tests).
    repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ]
    projects = []

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('normalizes registered repo paths before invoking github clients', async () => {
    getPRForBranchMock.mockResolvedValue({ number: 42 })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo/../repo',
      branch: 'feature/test'
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      null,
      null,
      null
    )
  })

  it('targets mutation notifications without broadcasting to 100 browser guests', async () => {
    const guestSends = Array.from({ length: 100 }, () => vi.fn())
    getAllWebContentsMock.mockReturnValue(
      guestSends.map((send, index) => ({
        id: index + 100,
        isDestroyed: () => false,
        send
      }))
    )
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:notifyWorkItemMutated'](
      { sender: { id: 1 } },
      {
        repoPath: '/home/runtime/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledOnce()
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      },
      1
    )
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(guestSends.reduce((total, send) => total + send.mock.calls.length, 0)).toBe(0)
  })

  it('targets mutation notifications with resolved repo id when called by repo path', async () => {
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:notifyWorkItemMutated'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        type: 'issue',
        number: 7
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'issue',
        number: 7
      },
      1
    )
  })

  it('targets PR file viewed mutations with repo id for cache invalidation', async () => {
    setPRFileViewedMock.mockResolvedValue(true)
    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:setPRFileViewed'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        pullRequestId: 'PR_kw',
        path: 'src/app.ts',
        viewed: true
      }
    )

    expect(result).toBe(true)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:workItemMutated',
      {
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        type: 'pr',
        number: 42
      },
      1
    )
  })

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('returns typed automatic PR refresh validation skips without enqueueing', async () => {
    registerGitHubHandlers(store as never, stats as never)
    const candidate = {
      cacheKey: 'missing::feature/test',
      repoPath: '/workspace/missing',
      repoId: 'missing-repo',
      branch: 'feature/test',
      repoKind: 'git' as const
    }

    const first = await handlers['gh:enqueuePRRefresh'](null, {
      candidate,
      reason: 'active',
      priority: 80
    })
    const second = await handlers['gh:enqueuePRRefresh'](null, {
      candidate,
      reason: 'active',
      priority: 80
    })

    expect(first).toEqual({ kind: 'skipped', skippedReason: 'validation-denied' })
    expect(second).toEqual({ kind: 'skipped', skippedReason: 'validation-backoff' })
    expect(first).not.toBe(false)
    expect(second).not.toBe(false)
    expect(enqueuePRRefreshMock).not.toHaveBeenCalled()
  })

  it('uses registered repo routing fields for automatic PR refresh candidates', async () => {
    repos = [
      {
        id: 'repo-ssh',
        path: '/workspace/remote-repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-real',
        executionHostId: 'ssh:ssh-real'
      }
    ]
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:enqueuePRRefresh'](null, {
      candidate: {
        cacheKey: 'remote::feature/test',
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        branch: 'feature/test',
        repoKind: 'git',
        connectionId: 'ssh-stale',
        executionHostId: 'runtime:stale',
        connectionState: 'disconnected',
        localGitOptions: { wslDistro: 'Stale' }
      },
      reason: 'active',
      priority: 80
    })

    const candidate = enqueuePRRefreshMock.mock.calls[0]?.[0]
    expect(candidate).toEqual(
      expect.objectContaining({
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        connectionId: 'ssh-real',
        executionHostId: 'ssh:ssh-real',
        connectionState: 'connected'
      })
    )
    expect(candidate).not.toHaveProperty('localGitOptions')
  })

  it('keeps manual PR refresh validation strict', async () => {
    registerGitHubHandlers(store as never, stats as never)

    await expect(
      handlers['gh:refreshPRNow'](null, {
        candidate: {
          cacheKey: 'missing::feature/test',
          repoPath: '/workspace/missing',
          repoId: 'missing-repo',
          branch: 'feature/test',
          repoKind: 'git'
        }
      })
    ).rejects.toThrow('Access denied: unknown repository path')

    expect(refreshPRNowMock).not.toHaveBeenCalled()
  })

  it('skips stale visible PR refresh candidates without rejecting the batch', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(
      handlers['gh:reportVisiblePRRefreshCandidates'](
        { sender: { id: 7, once: vi.fn() } },
        {
          generation: 1,
          candidates: [
            {
              cacheKey: '/workspace/repo::feature/live',
              repoPath: '/workspace/repo',
              branch: 'feature/live',
              repoKind: 'git',
              repoId: 'repo-1'
            },
            {
              cacheKey: '/workspace/missing::feature/stale',
              repoPath: '/workspace/missing',
              branch: 'feature/stale',
              repoKind: 'git',
              repoId: 'repo-missing'
            }
          ]
        }
      )
    ).toBe(true)

    expect(reportVisiblePRRefreshCandidatesMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          repoPath: '/workspace/repo',
          repoId: 'repo-1',
          branch: 'feature/live'
        })
      ],
      1,
      7
    )
  })

  it('clears a sender visible PR refresh set when all current candidates are invalid', async () => {
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:reportVisiblePRRefreshCandidates'](
      { sender: { id: 8, once: vi.fn() } },
      {
        generation: 2,
        candidates: [
          {
            cacheKey: 'missing::feature/old',
            repoPath: '/workspace/missing',
            repoId: 'missing-repo',
            branch: 'feature/old',
            repoKind: 'git'
          }
        ]
      }
    )

    expect(reportVisiblePRRefreshCandidatesMock).toHaveBeenCalledWith([], 2, 8)
  })

  it('rejects GitHub source context from a different host', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:listWorkItems'](null, {
        repoPath: '/workspace/repo',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-1'
        }
      })
    ).toThrow('Access denied: GitHub source host does not match repository host')

    expect(listWorkItemsMock).not.toHaveBeenCalled()
  })

  it('guards label metadata lookups with source host context', async () => {
    listLabelsMock.mockResolvedValue(['bug'])
    repos = [
      ...repos,
      {
        id: 'repo-ssh',
        path: '/workspace/remote-repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'openclaw-2',
        executionHostId: 'ssh:openclaw-2'
      }
    ]
    registerGitHubHandlers(store as never, stats as never)

    await expect(
      handlers['gh:listLabels'](null, {
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-ssh'
        }
      })
    ).resolves.toEqual(['bug'])

    expect(listLabelsMock).toHaveBeenCalledWith('/workspace/remote-repo', undefined, 'openclaw-2')
  })

  it('forwards listIssues for registered repositories and unwraps items', async () => {
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('drops the error field from listIssues envelope at the IPC boundary', async () => {
    // Why: src/main/ipc/github.ts intentionally unwraps the { items, error? }
    // envelope to just `items` to preserve the pre-feature-1
    // `Promise<IssueInfo[]>` contract for `gh:listIssues`. Feature 1's UI
    // consumes the richer envelope through `gh:listWorkItems` instead. This
    // test locks in that intentional drop so a future change that starts
    // propagating the error through this channel (or that throws when an
    // error is present) is caught.
    listIssuesMock.mockResolvedValue({
      items: [],
      error: {
        type: 'permission_denied',
        message:
          "You don't have permission to read issues for this repository. Check your GitHub token scopes."
      }
    })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('threads issueSourcePreference through gh:listIssues', async () => {
    // Why: repo.issueSourcePreference must reach listIssues so the upstream
    // repo is queried when configured. A regression that drops the arg would
    // pass the default-fixture tests (which assert `undefined`) silently, so
    // this test pins the non-undefined preference-threading contract.
    repos[0].issueSourcePreference = 'upstream'
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, 'upstream', null)
  })

  it('threads issueSourcePreference through gh:listWorkItems', async () => {
    // Why: gh:listWorkItems must also forward repo.issueSourcePreference
    // (5th arg) so the work-items view honors the per-repo source selector.
    repos[0].issueSourcePreference = 'origin'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: 'is:open',
      page: 2,
      noCache: true
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      'is:open',
      2,
      'origin',
      null,
      true
    )
  })

  it('routes local WSL project GitHub issue and work-item IPC through project git options', async () => {
    setPlatform('win32')
    projects = [
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
    projects = [
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

    expect(getWorkItemMock).toHaveBeenCalledWith('/workspace/repo', 42, 'pr', null, localGitOptions)
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
      localGitOptions
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

  it('threads SSH connectionId through GitHub work-item handlers', async () => {
    repos[0].connectionId = 'openclaw-2'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: ''
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      '',
      undefined,
      undefined,
      'openclaw-2',
      undefined
    )
  })

  it('threads SSH connectionId through pull request merge', async () => {
    repos[0].connectionId = 'openclaw-2'
    mergePRMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:mergePR'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(mergePRMock).toHaveBeenCalledWith('/workspace/repo', 42, 'squash', 'openclaw-2', {
      owner: 'acme',
      repo: 'orca'
    })
  })

  it('threads SSH connectionId through pull request auto-merge', async () => {
    repos[0].connectionId = 'openclaw-2'
    setPRAutoMergeMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:setPRAutoMerge'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        enabled: true,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(setPRAutoMergeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      true,
      'squash',
      'openclaw-2',
      {
        owner: 'acme',
        repo: 'orca'
      }
    )
  })

  it('forwards the authenticated viewer lookup', async () => {
    getAuthenticatedViewerMock.mockResolvedValue({ login: 'octocat', email: 'octocat@example.com' })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:viewer'](null, undefined)).resolves.toEqual({
      login: 'octocat',
      email: 'octocat@example.com'
    })
    expect(getAuthenticatedViewerMock).toHaveBeenCalled()
  })

  it('emits app_starred_orca once after a successful star with cohort context', async () => {
    starOrcaMock.mockResolvedValue(true)
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 3 })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'settings')).resolves.toBe(true)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(getCohortAtEmitMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('app_starred_orca', {
      source: 'settings',
      nth_repo_added: 3
    })
  })

  it('accepts every app star source for success telemetry', async () => {
    starOrcaMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    for (const source of [
      'star_nag',
      'agent_value_moment',
      'onboarding_completed',
      'settings',
      'landing'
    ] as const) {
      await expect(handlers['gh:starOrca'](null, source)).resolves.toBe(true)
    }

    expect(trackMock).toHaveBeenCalledTimes(5)
    expect(trackMock.mock.calls.map(([, props]) => props)).toEqual([
      { source: 'star_nag', nth_repo_added: undefined },
      { source: 'agent_value_moment', nth_repo_added: undefined },
      { source: 'onboarding_completed', nth_repo_added: undefined },
      { source: 'settings', nth_repo_added: undefined },
      { source: 'landing', nth_repo_added: undefined }
    ])
  })

  it('does not emit app_starred_orca when the star action returns false', async () => {
    starOrcaMock.mockResolvedValue(false)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'landing')).resolves.toBe(false)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('does not emit app_starred_orca when the star action throws', async () => {
    starOrcaMock.mockRejectedValue(new Error('gh failed'))

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'star_nag')).rejects.toThrow('gh failed')

    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('preserves star result but skips telemetry for an invalid IPC source', async () => {
    starOrcaMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'github_website')).resolves.toBe(true)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })
})
