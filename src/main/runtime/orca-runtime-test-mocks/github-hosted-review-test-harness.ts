import type * as RepoSlugUpstreamModule from '../../github/client/fetch/repo-slug-upstream'
import type * as GetPrForBranchModule from '../../github/client/lookup/get-pr-for-branch'
import type * as PrForBranchOutcomeModule from '../../github/client/lookup/pr-for-branch-outcome'
import type * as GetWorkItemModule from '../../github/client/fetch/get-work-item'
import type * as PullRequestPushTargetModule from '../../github/client/lookup/pull-request-push-target'
import type * as GetPrChecksModule from '../../github/client/check/get-pr-checks'
import type * as RerunPrChecksModule from '../../github/client/check/rerun-pr-checks'
import type * as GetPrCheckDetailsModule from '../../github/client/check/get-pr-check-details'
import type * as GetPrCommentsModule from '../../github/client/fetch/get-pr-comments'
import type * as ResolveReviewThreadModule from '../../github/client/update/resolve-review-thread'
import type * as PrFileViewedModule from '../../github/client/update/pr-file-viewed'
import type * as PrDetailsModule from '../../github/client/update/pr-details'
import type * as MergePrModule from '../../github/client/merge/merge-pr'
import type * as PrAutoMergeModule from '../../github/client/merge/pr-auto-merge'
import type * as PrStateModule from '../../github/client/update/pr-state'
import type * as PrReviewersModule from '../../github/client/update/pr-reviewers'
import type * as AddPrReviewCommentModule from '../../github/client/create/add-pr-review-comment'
import type * as IssuesModule from '../../github/issues/issues'
import type * as ListWorkItemsModule from '../../github/client/list/list-work-items'
import type * as CountWorkItemsModule from '../../github/client/list/count-work-items'
import type * as IssueCreateModule from '../../github/issues/issue-create'
import type * as IssueUpdateModule from '../../github/issues/issue-update'
import type * as IssueCommentModule from '../../github/issues/issue-comment'
import type * as IssueFieldOptionsModule from '../../github/issues/issue-field-options'
import type * as WorkItemDetailsModule from '../../github/work-items/work-item-details'
import type * as PullRequestFileContentsModule from '../../github/pull-requests/files/pull-request-file-contents'
import { vi, type Mock } from 'vitest'

// GitHub and hosted-review mocks shared by runtime specs through setup.spec.

type TestMock = Mock

const {
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  getGitHubWorkItemMock,
  getPullRequestPushTargetMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubPRFileContentsMock,
  getGitHubPRChecksMock,
  rerunGitHubPRChecksMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRCommentsMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRFileViewedMock,
  updateGitHubPRTitleMock,
  updateGitHubPRDetailsMock,
  mergeGitHubPRMock,
  setGitHubPRAutoMergeMock,
  updateGitHubPRStateMock,
  requestGitHubPRReviewersMock,
  removeGitHubPRReviewersMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  listGitHubIssuesMock,
  listGitHubWorkItemsMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  updateGitHubIssueMock,
  addGitHubIssueCommentMock,
  listGitHubLabelsMock,
  listGitHubAssignableUsersMock,
  getIssueMock
} = vi.hoisted(() => {
  return {
    createHostedReviewMock: vi.fn() as TestMock,
    createStackedHostedReviewMock: vi.fn() as TestMock,
    getHostedReviewCreationEligibilityMock: vi.fn() as TestMock,
    getHostedReviewForBranchMock: vi.fn() as TestMock,
    getPRForBranchMock: vi.fn().mockResolvedValue(null) as TestMock,
    getPRForBranchOutcomeMock: vi
      .fn()
      .mockResolvedValue({ kind: 'no-pr', fetchedAt: 0 }) as TestMock,
    getRepoSlugMock: vi.fn().mockResolvedValue(null) as TestMock,
    getRepoUpstreamMock: vi.fn().mockResolvedValue(null) as TestMock,
    getGitHubWorkItemMock: vi.fn() as TestMock,
    getPullRequestPushTargetMock: vi.fn() as TestMock,
    getGitHubWorkItemByOwnerRepoMock: vi.fn() as TestMock,
    getGitHubWorkItemDetailsMock: vi.fn() as TestMock,
    getGitHubPRFileContentsMock: vi.fn() as TestMock,
    getGitHubPRChecksMock: vi.fn() as TestMock,
    rerunGitHubPRChecksMock: vi.fn() as TestMock,
    getGitHubPRCheckDetailsMock: vi.fn() as TestMock,
    getGitHubPRCommentsMock: vi.fn() as TestMock,
    resolveGitHubReviewThreadMock: vi.fn() as TestMock,
    setGitHubPRFileViewedMock: vi.fn() as TestMock,
    updateGitHubPRTitleMock: vi.fn() as TestMock,
    updateGitHubPRDetailsMock: vi.fn() as TestMock,
    mergeGitHubPRMock: vi.fn() as TestMock,
    setGitHubPRAutoMergeMock: vi.fn() as TestMock,
    updateGitHubPRStateMock: vi.fn() as TestMock,
    requestGitHubPRReviewersMock: vi.fn() as TestMock,
    removeGitHubPRReviewersMock: vi.fn() as TestMock,
    addGitHubPRReviewCommentMock: vi.fn() as TestMock,
    addGitHubPRReviewCommentReplyMock: vi.fn() as TestMock,
    listGitHubIssuesMock: vi.fn() as TestMock,
    listGitHubWorkItemsMock: vi.fn() as TestMock,
    countGitHubWorkItemsMock: vi.fn() as TestMock,
    createGitHubIssueMock: vi.fn() as TestMock,
    updateGitHubIssueMock: vi.fn() as TestMock,
    addGitHubIssueCommentMock: vi.fn() as TestMock,
    listGitHubLabelsMock: vi.fn() as TestMock,
    listGitHubAssignableUsersMock: vi.fn() as TestMock,
    getIssueMock: vi.fn() as TestMock
  }
})

vi.mock('../../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
}))

vi.mock('../../source-control/stacked-hosted-review-creation', () => ({
  createStackedHostedReview: createStackedHostedReviewMock
}))

vi.mock('../../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock,
  // Handlers read through this; keep asserting on the one mock.
  readHostedReviewForBranch: vi.fn(async (input: unknown) => ({
    review: await getHostedReviewForBranchMock(input),
    readOutcome: 'cached'
  }))
}))

vi.mock('../../github/client/fetch/repo-slug-upstream', async (importOriginal) => ({
  ...(await importOriginal<typeof RepoSlugUpstreamModule>()),
  getRepoSlug: getRepoSlugMock,
  getRepoUpstream: getRepoUpstreamMock
}))

vi.mock('../../github/client/lookup/get-pr-for-branch', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrForBranchModule>()),
  getPRForBranch: getPRForBranchMock
}))

vi.mock('../../github/client/lookup/pr-for-branch-outcome', async (importOriginal) => ({
  ...(await importOriginal<typeof PrForBranchOutcomeModule>()),
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock('../../github/client/fetch/get-work-item', async (importOriginal) => ({
  ...(await importOriginal<typeof GetWorkItemModule>()),
  getWorkItem: getGitHubWorkItemMock,
  getWorkItemByOwnerRepo: getGitHubWorkItemByOwnerRepoMock
}))

vi.mock('../../github/client/lookup/pull-request-push-target', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof PullRequestPushTargetModule>()),
    getPullRequestPushTarget: getPullRequestPushTargetMock
  }
})

vi.mock('../../github/client/check/get-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrChecksModule>()),
  getPRChecks: getGitHubPRChecksMock
}))

vi.mock('../../github/client/check/rerun-pr-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof RerunPrChecksModule>()),
  rerunPRChecks: rerunGitHubPRChecksMock
}))

vi.mock('../../github/client/check/get-pr-check-details', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCheckDetailsModule>()),
  getPRCheckDetails: getGitHubPRCheckDetailsMock
}))

vi.mock('../../github/client/fetch/get-pr-comments', async (importOriginal) => ({
  ...(await importOriginal<typeof GetPrCommentsModule>()),
  getPRComments: getGitHubPRCommentsMock
}))

vi.mock('../../github/client/update/resolve-review-thread', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolveReviewThreadModule>()),
  resolveReviewThread: resolveGitHubReviewThreadMock
}))

vi.mock('../../github/client/update/pr-file-viewed', async (importOriginal) => ({
  ...(await importOriginal<typeof PrFileViewedModule>()),
  setPRFileViewed: setGitHubPRFileViewedMock
}))

vi.mock('../../github/client/update/pr-details', async (importOriginal) => ({
  ...(await importOriginal<typeof PrDetailsModule>()),
  updatePRTitle: updateGitHubPRTitleMock,
  updatePRDetails: updateGitHubPRDetailsMock
}))

vi.mock('../../github/client/merge/merge-pr', async (importOriginal) => ({
  ...(await importOriginal<typeof MergePrModule>()),
  mergePR: mergeGitHubPRMock
}))

vi.mock('../../github/client/merge/pr-auto-merge', async (importOriginal) => ({
  ...(await importOriginal<typeof PrAutoMergeModule>()),
  setPRAutoMerge: setGitHubPRAutoMergeMock
}))

vi.mock('../../github/client/update/pr-state', async (importOriginal) => ({
  ...(await importOriginal<typeof PrStateModule>()),
  updatePRState: updateGitHubPRStateMock
}))

vi.mock('../../github/client/update/pr-reviewers', async (importOriginal) => ({
  ...(await importOriginal<typeof PrReviewersModule>()),
  requestPRReviewers: requestGitHubPRReviewersMock,
  removePRReviewers: removeGitHubPRReviewersMock
}))

vi.mock('../../github/client/create/add-pr-review-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof AddPrReviewCommentModule>()),
  addPRReviewComment: addGitHubPRReviewCommentMock,
  addPRReviewCommentReply: addGitHubPRReviewCommentReplyMock
}))

vi.mock('../../github/issues/issues', async (importOriginal) => ({
  ...(await importOriginal<typeof IssuesModule>()),
  listIssues: listGitHubIssuesMock,
  getIssue: getIssueMock
}))

vi.mock('../../github/client/list/list-work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof ListWorkItemsModule>()),
  listWorkItems: listGitHubWorkItemsMock
}))

vi.mock('../../github/client/list/count-work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof CountWorkItemsModule>()),
  countWorkItems: countGitHubWorkItemsMock
}))

vi.mock('../../github/issues/issue-create', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCreateModule>()),
  createIssue: createGitHubIssueMock
}))

vi.mock('../../github/issues/issue-update', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueUpdateModule>()),
  updateIssue: updateGitHubIssueMock
}))

vi.mock('../../github/issues/issue-comment', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueCommentModule>()),
  addIssueComment: addGitHubIssueCommentMock
}))

vi.mock('../../github/issues/issue-field-options', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueFieldOptionsModule>()),
  listLabels: listGitHubLabelsMock,
  listAssignableUsers: listGitHubAssignableUsersMock
}))

vi.mock('../../github/work-items/work-item-details', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorkItemDetailsModule>()),
    getWorkItemDetails: getGitHubWorkItemDetailsMock
  }
})

vi.mock('../../github/pull-requests/files/pull-request-file-contents', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof PullRequestFileContentsModule>()),
    getPRFileContents: getGitHubPRFileContentsMock
  }
})

export {
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  getPRForBranchMock,
  getPRForBranchOutcomeMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  getGitHubWorkItemMock,
  getPullRequestPushTargetMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubPRFileContentsMock,
  getGitHubPRChecksMock,
  rerunGitHubPRChecksMock,
  getGitHubPRCheckDetailsMock,
  getGitHubPRCommentsMock,
  resolveGitHubReviewThreadMock,
  setGitHubPRFileViewedMock,
  updateGitHubPRTitleMock,
  updateGitHubPRDetailsMock,
  mergeGitHubPRMock,
  setGitHubPRAutoMergeMock,
  updateGitHubPRStateMock,
  requestGitHubPRReviewersMock,
  removeGitHubPRReviewersMock,
  addGitHubPRReviewCommentMock,
  addGitHubPRReviewCommentReplyMock,
  listGitHubIssuesMock,
  listGitHubWorkItemsMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  updateGitHubIssueMock,
  addGitHubIssueCommentMock,
  listGitHubLabelsMock,
  listGitHubAssignableUsersMock,
  getIssueMock
}
