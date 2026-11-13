import type * as GetPrForBranchModule from '../../github/client/lookup/get-pr-for-branch'
import type * as IssuesModule from '../../github/issues/issues'
import type * as GetWorkItemModule from '../../github/client/fetch/get-work-item'
import type * as ListWorkItemsModule from '../../github/client/list/list-work-items'
import type * as CountWorkItemsModule from '../../github/client/list/count-work-items'
import type * as IssueCreateModule from '../../github/issues/issue-create'
import type * as IssueUpdateModule from '../../github/issues/issue-update'
import type * as IssueCommentModule from '../../github/issues/issue-comment'
import type * as IssueFieldOptionsModule from '../../github/issues/issue-field-options'
import type * as AuthenticatedViewerModule from '../../github/client/fetch/authenticated-viewer'
import type * as GetPrChecksModule from '../../github/client/check/get-pr-checks'
import type * as GetPrCheckDetailsModule from '../../github/client/check/get-pr-check-details'
import type * as GetPrCommentsModule from '../../github/client/fetch/get-pr-comments'
import type * as PrCommentReactionModule from '../../github/client/update/pr-comment-reaction'
import type * as ResolveReviewThreadModule from '../../github/client/update/resolve-review-thread'
import type * as PrFileViewedModule from '../../github/client/update/pr-file-viewed'
import type * as AddPrReviewCommentModule from '../../github/client/create/add-pr-review-comment'
import type * as PrDetailsModule from '../../github/client/update/pr-details'
import type * as MergePrModule from '../../github/client/merge/merge-pr'
import type * as PrAutoMergeModule from '../../github/client/merge/pr-auto-merge'
import type * as PrStateModule from '../../github/client/update/pr-state'
import type * as PrReadyModule from '../../github/client/update/pr-ready'
import type * as RerunPrChecksModule from '../../github/client/check/rerun-pr-checks'
import type * as PrReviewersModule from '../../github/client/update/pr-reviewers'
import type * as OrcaStarModule from '../../github/client/fetch/orca-star'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../github/client/lookup/get-pr-for-branch', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrForBranchModule>()),
  getPRForBranch: mocks.client.getPRForBranch
}))

vi.mock('../../github/issues/issues', async (importOriginal) => ({
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

vi.mock('../../github/client/list/count-work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof CountWorkItemsModule>()),
  countWorkItems: mocks.client.countWorkItems
}))

vi.mock('../../github/issues/issue-create', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCreateModule>()),
  createIssue: mocks.client.createIssue
}))

vi.mock('../../github/issues/issue-update', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueUpdateModule>()),
  updateIssue: mocks.client.updateIssue
}))

vi.mock('../../github/issues/issue-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCommentModule>()),
  addIssueComment: mocks.client.addIssueComment
}))

vi.mock('../../github/issues/issue-field-options', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueFieldOptionsModule>()),
  listLabels: mocks.client.listLabels,
  listAssignableUsers: mocks.client.listAssignableUsers
}))

vi.mock('../../github/client/fetch/authenticated-viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticatedViewerModule>()),
  getAuthenticatedViewer: mocks.client.getAuthenticatedViewer
}))

vi.mock('../../github/client/check/get-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrChecksModule>()),
  getPRChecks: mocks.client.getPRChecks
}))

vi.mock('../../github/client/check/get-pr-check-details', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCheckDetailsModule>()),
  getPRCheckDetails: mocks.client.getPRCheckDetails
}))

vi.mock('../../github/client/fetch/get-pr-comments', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCommentsModule>()),
  getPRComments: mocks.client.getPRComments
}))

vi.mock('../../github/client/update/pr-comment-reaction', async (importOriginal) => ({
  ...(await importOriginal<typeof PrCommentReactionModule>()),
  setPRCommentReaction: mocks.client.setPRCommentReaction
}))

vi.mock('../../github/client/update/resolve-review-thread', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveReviewThreadModule>()),
  resolveReviewThread: mocks.client.resolveReviewThread
}))

vi.mock('../../github/client/update/pr-file-viewed', async (importOriginal) => ({
  ...(await importOriginal<typeof PrFileViewedModule>()),
  setPRFileViewed: mocks.client.setPRFileViewed
}))

vi.mock('../../github/client/create/add-pr-review-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof AddPrReviewCommentModule>()),
  addPRReviewComment: mocks.client.addPRReviewComment,
  addPRReviewCommentReply: mocks.client.addPRReviewCommentReply
}))

vi.mock('../../github/client/update/pr-details', async (importOriginal) => ({
  ...(await importOriginal<typeof PrDetailsModule>()),
  updatePRTitle: mocks.client.updatePRTitle
}))

vi.mock('../../github/client/merge/merge-pr', async (importOriginal) => ({
  ...(await importOriginal<typeof MergePrModule>()),
  mergePR: mocks.client.mergePR
}))

vi.mock('../../github/client/merge/pr-auto-merge', async (importOriginal) => ({
  ...(await importOriginal<typeof PrAutoMergeModule>()),
  setPRAutoMerge: mocks.client.setPRAutoMerge
}))

vi.mock('../../github/client/update/pr-state', async (importOriginal) => ({
  ...(await importOriginal<typeof PrStateModule>()),
  updatePRState: mocks.client.updatePRState
}))

vi.mock('../../github/client/update/pr-ready', async (importOriginal) => ({
  ...(await importOriginal<typeof PrReadyModule>()),
  markPRReadyForReview: mocks.client.markPRReadyForReview,
  markPRDraft: mocks.client.markPRDraft
}))

vi.mock('../../github/client/check/rerun-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof RerunPrChecksModule>()),
  rerunPRChecks: mocks.client.rerunPRChecks
}))

vi.mock('../../github/client/update/pr-reviewers', async (importOriginal) => ({
  ...(await importOriginal<typeof PrReviewersModule>()),
  requestPRReviewers: mocks.client.requestPRReviewers,
  removePRReviewers: mocks.client.removePRReviewers
}))

vi.mock('../../github/client/fetch/orca-star', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcaStarModule>()),
  checkOrcaStarred: mocks.client.checkOrcaStarred,
  starOrca: mocks.client.starOrca
}))

vi.mock('../../github/client/fetch/repo-slug-upstream', () => ({}))

vi.mock('../../github/work-items/work-item-details', () => {
  return {
    getWorkItemDetails: mocks.workItemDetails.getWorkItemDetails
  }
})

vi.mock('../../github/pull-requests/files/pull-request-file-contents', () => {
  return {
    getPRFileContents: mocks.workItemDetails.getPRFileContents
  }
})
vi.mock('../../github/pull-requests/refresh/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../../telemetry/client', () => mocks.telemetry)
vi.mock('../../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('../ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const { getIssue: getIssueMock, listWorkItems: listWorkItemsMock } = mocks.client

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness
  const runtime = { notifyPullRequestChangedForRemoteClients: () => {} }

  beforeEach(harness.reset)

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never, stats as never, runtime)

    // Background issue reads are async (they check the repo's WSL distro first), so access errors reject.
    await expect(async () =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).rejects.toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('rejects GitHub source context from a different host', async () => {
    registerGitHubHandlers(store as never, stats as never, runtime)

    await expect(async () =>
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
    ).rejects.toThrow('Access denied: GitHub source host does not match repository host')

    expect(listWorkItemsMock).not.toHaveBeenCalled()
  })
})
