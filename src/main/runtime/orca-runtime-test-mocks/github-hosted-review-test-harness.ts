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
  ...(await importOriginal<Record<string, unknown>>()),
  getRepoSlug: getRepoSlugMock,
  getRepoUpstream: getRepoUpstreamMock
}))

vi.mock('../../github/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getPRForBranch: getPRForBranchMock,
    getPRForBranchOutcome: getPRForBranchOutcomeMock,
    getRepoSlug: getRepoSlugMock,
    getRepoUpstream: getRepoUpstreamMock,
    getWorkItem: getGitHubWorkItemMock,
    getPullRequestPushTarget: getPullRequestPushTargetMock,
    getWorkItemByOwnerRepo: getGitHubWorkItemByOwnerRepoMock,
    getPRChecks: getGitHubPRChecksMock,
    rerunPRChecks: rerunGitHubPRChecksMock,
    getPRCheckDetails: getGitHubPRCheckDetailsMock,
    getPRComments: getGitHubPRCommentsMock,
    resolveReviewThread: resolveGitHubReviewThreadMock,
    setPRFileViewed: setGitHubPRFileViewedMock,
    updatePRTitle: updateGitHubPRTitleMock,
    updatePRDetails: updateGitHubPRDetailsMock,
    mergePR: mergeGitHubPRMock,
    setPRAutoMerge: setGitHubPRAutoMergeMock,
    updatePRState: updateGitHubPRStateMock,
    requestPRReviewers: requestGitHubPRReviewersMock,
    removePRReviewers: removeGitHubPRReviewersMock,
    addPRReviewComment: addGitHubPRReviewCommentMock,
    addPRReviewCommentReply: addGitHubPRReviewCommentReplyMock,
    listIssues: listGitHubIssuesMock,
    listWorkItems: listGitHubWorkItemsMock,
    countWorkItems: countGitHubWorkItemsMock,
    getIssue: getIssueMock,
    createIssue: createGitHubIssueMock,
    updateIssue: updateGitHubIssueMock,
    addIssueComment: addGitHubIssueCommentMock,
    listLabels: listGitHubLabelsMock,
    listAssignableUsers: listGitHubAssignableUsersMock
  }
})

vi.mock('../../github/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitHubWorkItemDetailsMock,
    getPRFileContents: getGitHubPRFileContentsMock
  }
})

vi.mock('../../github/issues', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: getIssueMock,
    listIssues: listGitHubIssuesMock
  }
})

vi.mock(import('../../github/client/lookup/pr-for-branch-outcome'), async (importOriginal) => ({
  ...(await importOriginal()),
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock(import('../../github/client/fetch/get-work-item'), async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkItem: getGitHubWorkItemMock,
  getWorkItemByOwnerRepo: getGitHubWorkItemByOwnerRepoMock
}))

vi.mock(import('../../github/client/check/get-pr-checks'), async (importOriginal) => ({
  ...(await importOriginal()),
  getPRChecks: getGitHubPRChecksMock
}))

vi.mock(import('../../github/client/check/rerun-pr-checks'), async (importOriginal) => ({
  ...(await importOriginal()),
  rerunPRChecks: rerunGitHubPRChecksMock
}))

vi.mock(import('../../github/client/check/get-pr-check-details'), async (importOriginal) => ({
  ...(await importOriginal()),
  getPRCheckDetails: getGitHubPRCheckDetailsMock
}))

vi.mock(import('../../github/client/fetch/get-pr-comments'), async (importOriginal) => ({
  ...(await importOriginal()),
  getPRComments: getGitHubPRCommentsMock
}))

vi.mock(import('../../github/client/update/resolve-review-thread'), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveReviewThread: resolveGitHubReviewThreadMock
}))

vi.mock(import('../../github/client/update/pr-file-viewed'), async (importOriginal) => ({
  ...(await importOriginal()),
  setPRFileViewed: setGitHubPRFileViewedMock
}))

vi.mock(import('../../github/client/update/pr-details'), async (importOriginal) => ({
  ...(await importOriginal()),
  updatePRTitle: updateGitHubPRTitleMock,
  updatePRDetails: updateGitHubPRDetailsMock
}))

vi.mock(import('../../github/client/merge/merge-pr'), async (importOriginal) => ({
  ...(await importOriginal()),
  mergePR: mergeGitHubPRMock
}))

vi.mock(import('../../github/client/merge/pr-auto-merge'), async (importOriginal) => ({
  ...(await importOriginal()),
  setPRAutoMerge: setGitHubPRAutoMergeMock
}))

vi.mock(import('../../github/client/update/pr-state'), async (importOriginal) => ({
  ...(await importOriginal()),
  updatePRState: updateGitHubPRStateMock
}))

vi.mock(import('../../github/client/update/pr-reviewers'), async (importOriginal) => ({
  ...(await importOriginal()),
  requestPRReviewers: requestGitHubPRReviewersMock,
  removePRReviewers: removeGitHubPRReviewersMock
}))

vi.mock(import('../../github/client/create/add-pr-review-comment'), async (importOriginal) => ({
  ...(await importOriginal()),
  addPRReviewComment: addGitHubPRReviewCommentMock,
  addPRReviewCommentReply: addGitHubPRReviewCommentReplyMock
}))

vi.mock(import('../../github/client/list/list-work-items'), async (importOriginal) => ({
  ...(await importOriginal()),
  listWorkItems: listGitHubWorkItemsMock
}))

vi.mock(import('../../github/client/list/count-work-items'), async (importOriginal) => ({
  ...(await importOriginal()),
  countWorkItems: countGitHubWorkItemsMock
}))

vi.mock(import('../../github/issue-create'), async (importOriginal) => ({
  ...(await importOriginal()),
  createIssue: createGitHubIssueMock
}))

vi.mock(import('../../github/issue-update'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateIssue: updateGitHubIssueMock
}))

vi.mock(import('../../github/issue-comment'), async (importOriginal) => ({
  ...(await importOriginal()),
  addIssueComment: addGitHubIssueCommentMock
}))

vi.mock(import('../../github/issue-field-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  listLabels: listGitHubLabelsMock,
  listAssignableUsers: listGitHubAssignableUsersMock
}))

vi.mock(import('../../github/client/lookup/get-pr-for-branch'), async (importOriginal) => ({
  ...(await importOriginal()),
  getPRForBranch: getPRForBranchMock
}))

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
