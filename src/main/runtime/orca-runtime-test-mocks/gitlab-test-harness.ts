import { vi, type Mock } from 'vitest'

// GitLab mocks shared by runtime specs through setup.spec.

type TestMock = Mock

const {
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock
} = vi.hoisted(() => {
  return {
    listGitLabMergeRequestsMock: vi.fn() as TestMock,
    listGitLabWorkItemsMock: vi.fn() as TestMock,
    listGitLabIssuesMock: vi.fn() as TestMock,
    listGitLabLabelsMock: vi.fn() as TestMock,
    listGitLabAssignableUsersMock: vi.fn<TestMock>(),
    listGitLabTodosMock: vi.fn() as TestMock,
    getGitLabProjectRefForRemoteMock: vi.fn() as TestMock,
    getGitLabWorkItemByProjectRefMock: vi.fn() as TestMock,
    createGitLabIssueMock: vi.fn() as TestMock,
    updateGitLabIssueMock: vi.fn() as TestMock,
    addGitLabIssueCommentMock: vi.fn() as TestMock,
    addGitLabMRCommentMock: vi.fn() as TestMock,
    addGitLabMRInlineCommentMock: vi.fn() as TestMock,
    resolveGitLabMRDiscussionMock: vi.fn() as TestMock,
    getGitLabJobTraceMock: vi.fn() as TestMock,
    retryGitLabJobMock: vi.fn() as TestMock,
    mergeGitLabMRMock: vi.fn() as TestMock,
    closeGitLabMRMock: vi.fn() as TestMock,
    reopenGitLabMRMock: vi.fn() as TestMock,
    updateGitLabMRMock: vi.fn() as TestMock,
    getGlabKnownHostsMock: vi.fn() as TestMock,
    getGitLabWorkItemDetailsMock: vi.fn() as TestMock,
    updateGitLabMRReviewersMock: vi.fn() as TestMock
  }
})

vi.mock('../../gitlab/work-items/work-item-details', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitLabWorkItemDetailsMock
  }
})

vi.mock(import('../../gitlab/merge-requests/merge-request-list'), async (importOriginal) => ({
  ...(await importOriginal()),
  listMergeRequests: listGitLabMergeRequestsMock
}))

vi.mock(import('../../gitlab/work-items/work-item-queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  listWorkItems: listGitLabWorkItemsMock,
  listTodos: listGitLabTodosMock,
  getWorkItemByProjectRef: getGitLabWorkItemByProjectRefMock
}))

vi.mock(import('../../gitlab/issues/gitlab-issue-queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  listIssues: listGitLabIssuesMock,
  createIssue: createGitLabIssueMock,
  addIssueComment: addGitLabIssueCommentMock
}))

vi.mock(
  import('../../gitlab/projects/project-label-and-member-lookup'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    listLabels: listGitLabLabelsMock,
    listAssignableUsers: listGitLabAssignableUsersMock
  })
)

vi.mock(import('../../gitlab/projects/gitlab-project-ref-resolution'), async (importOriginal) => ({
  ...(await importOriginal()),
  getProjectRefForRemote: getGitLabProjectRefForRemoteMock
}))

vi.mock(import('../../gitlab/issues/issue-update'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateIssue: updateGitLabIssueMock
}))

vi.mock(
  import('../../gitlab/merge-requests/merge-request-review-mutations'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    addMRComment: addGitLabMRCommentMock,
    addMRInlineComment: addGitLabMRInlineCommentMock,
    resolveMRDiscussion: resolveGitLabMRDiscussionMock,
    updateMRReviewers: updateGitLabMRReviewersMock
  })
)

vi.mock(import('../../gitlab/pipelines/pipeline-job-mutations'), async (importOriginal) => ({
  ...(await importOriginal()),
  getJobTrace: getGitLabJobTraceMock,
  retryJob: retryGitLabJobMock
}))

vi.mock(
  import('../../gitlab/merge-requests/merge-request-state-mutations'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    mergeMR: mergeGitLabMRMock,
    closeMR: closeGitLabMRMock,
    reopenMR: reopenGitLabMRMock
  })
)

vi.mock(import('../../gitlab/merge-requests/merge-request-update'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateMR: updateGitLabMRMock
}))

vi.mock(import('../../gitlab/projects/gitlab-known-host-probe'), async (importOriginal) => ({
  ...(await importOriginal()),
  getGlabKnownHosts: getGlabKnownHostsMock
}))

export {
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock
}
