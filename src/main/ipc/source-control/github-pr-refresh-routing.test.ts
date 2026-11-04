import type * as OrcaStarModule from '../../github/client/fetch/orca-star'
import type * as AuthenticatedViewerModule from '../../github/client/fetch/authenticated-viewer'
import type * as IssueCommentModule from '../../github/issue-comment'
import type * as IssueFieldOptionsModule from '../../github/issue-field-options'
import type * as IssueUpdateModule from '../../github/issue-update'
import type * as PrReadyModule from '../../github/client/update/pr-ready'
import type * as MergePrModule from '../../github/client/merge/merge-pr'
import type * as PrReviewersModule from '../../github/client/update/pr-reviewers'
import type * as RerunPrChecksModule from '../../github/client/check/rerun-pr-checks'
import type * as PrAutoMergeModule from '../../github/client/merge/pr-auto-merge'
import type * as PrStateModule from '../../github/client/update/pr-state'
import type * as PrDetailsModule from '../../github/client/update/pr-details'
import type * as GetPrCheckDetailsModule from '../../github/client/check/get-pr-check-details'
import type * as GetPrChecksModule from '../../github/client/check/get-pr-checks'
import type * as GetPrCommentsModule from '../../github/client/fetch/get-pr-comments'
import type * as ResolveReviewThreadModule from '../../github/client/update/resolve-review-thread'
import type * as PrCommentReactionModule from '../../github/client/update/pr-comment-reaction'
import type * as GetPrForBranchModule from '../../github/client/lookup/get-pr-for-branch'
import type * as AddPrReviewCommentModule from '../../github/client/create/add-pr-review-comment'
import type * as PrFileViewedModule from '../../github/client/update/pr-file-viewed'
import type * as CountWorkItemsModule from '../../github/client/list/count-work-items'
import type * as IssueCreateModule from '../../github/issue-create'
import type * as IssuesModule from '../../github/issues'
import type * as GetWorkItemModule from '../../github/client/fetch/get-work-item'
import type * as ListWorkItemsModule from '../../github/client/list/list-work-items'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../github/client', () => mocks.client)

vi.mock('../../github/client/fetch/orca-star', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcaStarModule>()),
  checkOrcaStarred: mocks.client.checkOrcaStarred,
  starOrca: mocks.client.starOrca
}))

vi.mock('../../github/client/fetch/authenticated-viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticatedViewerModule>()),
  getAuthenticatedViewer: mocks.client.getAuthenticatedViewer
}))

vi.mock('../../github/issue-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCommentModule>()),
  addIssueComment: mocks.client.addIssueComment
}))

vi.mock('../../github/issue-field-options', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueFieldOptionsModule>()),
  listAssignableUsers: mocks.client.listAssignableUsers,
  listLabels: mocks.client.listLabels
}))

vi.mock('../../github/issue-update', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueUpdateModule>()),
  updateIssue: mocks.client.updateIssue
}))

vi.mock('../../github/client/update/pr-ready', async (importOriginal) => ({
  ...(await importOriginal<typeof PrReadyModule>()),
  markPRReadyForReview: mocks.client.markPRReadyForReview
}))

vi.mock('../../github/client/merge/merge-pr', async (importOriginal) => ({
  ...(await importOriginal<typeof MergePrModule>()),
  mergePR: mocks.client.mergePR
}))

vi.mock('../../github/client/update/pr-reviewers', async (importOriginal) => ({
  ...(await importOriginal<typeof PrReviewersModule>()),
  removePRReviewers: mocks.client.removePRReviewers,
  requestPRReviewers: mocks.client.requestPRReviewers
}))

vi.mock('../../github/client/check/rerun-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof RerunPrChecksModule>()),
  rerunPRChecks: mocks.client.rerunPRChecks
}))

vi.mock('../../github/client/merge/pr-auto-merge', async (importOriginal) => ({
  ...(await importOriginal<typeof PrAutoMergeModule>()),
  setPRAutoMerge: mocks.client.setPRAutoMerge
}))

vi.mock('../../github/client/update/pr-state', async (importOriginal) => ({
  ...(await importOriginal<typeof PrStateModule>()),
  updatePRState: mocks.client.updatePRState
}))

vi.mock('../../github/client/update/pr-details', async (importOriginal) => ({
  ...(await importOriginal<typeof PrDetailsModule>()),
  updatePRTitle: mocks.client.updatePRTitle
}))

vi.mock('../../github/client/check/get-pr-check-details', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCheckDetailsModule>()),
  getPRCheckDetails: mocks.client.getPRCheckDetails
}))

vi.mock('../../github/client/check/get-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrChecksModule>()),
  getPRChecks: mocks.client.getPRChecks
}))

vi.mock('../../github/client/fetch/get-pr-comments', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCommentsModule>()),
  getPRComments: mocks.client.getPRComments
}))

vi.mock('../../github/client/fetch/repo-slug-upstream', () => ({}))

vi.mock('../../github/client/update/resolve-review-thread', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveReviewThreadModule>()),
  resolveReviewThread: mocks.client.resolveReviewThread
}))

vi.mock('../../github/client/update/pr-comment-reaction', async (importOriginal) => ({
  ...(await importOriginal<typeof PrCommentReactionModule>()),
  setPRCommentReaction: mocks.client.setPRCommentReaction
}))

vi.mock('../../github/client/lookup/get-pr-for-branch', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrForBranchModule>()),
  getPRForBranch: mocks.client.getPRForBranch
}))

vi.mock('../../github/client/create/add-pr-review-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof AddPrReviewCommentModule>()),
  addPRReviewComment: mocks.client.addPRReviewComment,
  addPRReviewCommentReply: mocks.client.addPRReviewCommentReply
}))

vi.mock('../../github/client/update/pr-file-viewed', async (importOriginal) => ({
  ...(await importOriginal<typeof PrFileViewedModule>()),
  setPRFileViewed: mocks.client.setPRFileViewed
}))

vi.mock('../../github/client/list/count-work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof CountWorkItemsModule>()),
  countWorkItems: mocks.client.countWorkItems
}))

vi.mock('../../github/issue-create', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCreateModule>()),
  createIssue: mocks.client.createIssue
}))

vi.mock('../../github/issues', async (importOriginal) => ({
  ...(await importOriginal<typeof IssuesModule>()),
  getIssue: mocks.client.getIssue,
  listIssues: mocks.client.listIssues
}))

vi.mock('../../github/client/fetch/get-work-item', async (importOriginal) => ({
  ...(await importOriginal<typeof GetWorkItemModule>()),
  getWorkItem: mocks.client.getWorkItem,
  getWorkItemByOwnerRepo: mocks.client.getWorkItemByOwnerRepo
}))

vi.mock('../../github/client/list/list-work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof ListWorkItemsModule>()),
  listWorkItems: mocks.client.listWorkItems
}))
vi.mock('../../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../../telemetry/client', () => mocks.telemetry)
vi.mock('../../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('../ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const {
  refreshPRNow: refreshPRNowMock,
  enqueuePRRefresh: enqueuePRRefreshMock,
  reportVisiblePRRefreshCandidates: reportVisiblePRRefreshCandidatesMock
} = mocks.prRefresh

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

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
    harness.repos = [
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
    // A re-added project gets a new id; queued work keyed by path and host must still run.
    const isRegistered = mocks.prRefresh.setPRRefreshRegistrationCheck.mock.lastCall?.[0]
    expect(isRegistered?.({ ...candidate, repoId: 're-added-repo' })).toBe(true)
  })

  it('forwards explicit intent on the invocation, never the reusable candidate', async () => {
    registerGitHubHandlers(store as never, stats as never)
    refreshPRNowMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })
    await handlers['gh:refreshPRNow'](null, {
      candidate: {
        cacheKey: 'click',
        repoPath: '/workspace/repo',
        repoId: 'repo-1',
        branch: 'main',
        repoKind: 'git'
      },
      reason: 'manual',
      userRefresh: true
    })
    expect(refreshPRNowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ userRefresh: true }),
      'manual',
      { userRefresh: true }
    )
    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo',
      branch: 'main',
      userRefresh: true
    })
    expect(mocks.client.getPRForBranch).toHaveBeenCalledWith(
      '/workspace/repo',
      'main',
      null,
      null,
      null,
      expect.objectContaining({ userRefresh: true })
    )
    await handlers['gh:prChecks'](null, {
      repoPath: '/workspace/repo',
      prNumber: 12,
      noCache: true,
      userRefresh: true
    })
    expect(mocks.client.getPRChecks.mock.calls[0]?.[4]).toEqual({
      noCache: true,
      userRefresh: true
    })
  })

  it('skips stale visible PR refresh candidates without rejecting the batch', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(
      handlers['gh:reportVisiblePRRefreshCandidates'](
        { sender: Object.assign(new EventEmitter(), { id: 7 }) },
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
})
