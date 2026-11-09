import { repo } from './gitlab-ipc-repository-fixture'
import type * as PipelineJobMutationsModule from '../../gitlab/pipeline-job-mutations'
import type * as IssuesModule from '../../gitlab/issues'
import type * as ProjectLabelAndMemberLookupModule from '../../gitlab/project-label-and-member-lookup'
import type * as IssueUpdateModule from '../../gitlab/issue-update'
import type * as MergeRequestReviewMutationsModule from '../../gitlab/merge-request-review-mutations'
import type * as MergeRequestStateMutationsModule from '../../gitlab/merge-request-state-mutations'
import type * as MergeRequestUpdateModule from '../../gitlab/merge-request-update'
import type * as MergeRequestLookupModule from '../../gitlab/merge-request-lookup'
import type * as MergeRequestListModule from '../../gitlab/merge-request-list'
import type * as WorkItemQueriesModule from '../../gitlab/work-item-queries'
import type * as ClientModule from '../../gitlab/client'
import type * as GitlabAuthAndRateLimitModule from '../../gitlab/gitlab-auth-and-rate-limit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'

const ORIGINAL_PLATFORM = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

const {
  ipcHandlers,
  listMergeRequestsMock,
  getIssueMock,
  listIssuesMock,
  createIssueMock,
  updateIssueMock,
  addIssueCommentMock,
  closeMRMock,
  reopenMRMock,
  mergeMRMock,
  updateMRMock,
  updateMRReviewersMock,
  addMRCommentMock,
  addMRInlineCommentMock,
  resolveMRDiscussionMock,
  getJobTraceMock,
  retryJobMock,
  listLabelsMock,
  listAssignableUsersMock,
  listTodosMock,
  listWorkItemsMock,
  getWorkItemDetailsMock,
  getWorkItemByProjectRefMock,
  getMergeRequestMock,
  getMergeRequestForBranchMock,
  getProjectSlugMock
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  listMergeRequestsMock: vi.fn(),
  getIssueMock: vi.fn(),
  listIssuesMock: vi.fn(),
  createIssueMock: vi.fn(),
  updateIssueMock: vi.fn(),
  addIssueCommentMock: vi.fn(),
  closeMRMock: vi.fn(),
  reopenMRMock: vi.fn(),
  mergeMRMock: vi.fn(),
  updateMRMock: vi.fn(),
  updateMRReviewersMock: vi.fn(),
  addMRCommentMock: vi.fn(),
  addMRInlineCommentMock: vi.fn(),
  resolveMRDiscussionMock: vi.fn(),
  getJobTraceMock: vi.fn(),
  retryJobMock: vi.fn(),
  listLabelsMock: vi.fn(),
  listAssignableUsersMock: vi.fn(),
  listTodosMock: vi.fn(),
  listWorkItemsMock: vi.fn(),
  getWorkItemDetailsMock: vi.fn(),
  getWorkItemByProjectRefMock: vi.fn(),
  getMergeRequestMock: vi.fn(),
  getMergeRequestForBranchMock: vi.fn(),
  getProjectSlugMock: vi.fn()
}))
const readWslDistroRunningStateMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../../gitlab/client', () => ({
  addIssueComment: addIssueCommentMock,
  addMRInlineComment: addMRInlineCommentMock,
  addMRComment: addMRCommentMock,
  closeMR: closeMRMock,
  createIssue: createIssueMock,
  diagnoseAuth: vi.fn(),
  getAuthenticatedViewer: vi.fn(),
  getJobTrace: getJobTraceMock,
  getIssue: getIssueMock,
  getMergeRequest: getMergeRequestMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getProjectSlug: getProjectSlugMock,
  getRateLimit: vi.fn(),
  getWorkItemByProjectRef: getWorkItemByProjectRefMock,
  listAssignableUsers: listAssignableUsersMock,
  listIssues: listIssuesMock,
  listLabels: listLabelsMock,
  listMergeRequests: listMergeRequestsMock,
  listTodos: listTodosMock,
  listWorkItems: listWorkItemsMock,
  mergeMR: mergeMRMock,
  reopenMR: reopenMRMock,
  resolveMRDiscussion: resolveMRDiscussionMock,
  retryJob: retryJobMock,
  updateIssue: updateIssueMock,
  updateMR: updateMRMock,
  updateMRReviewers: updateMRReviewersMock
}))

vi.mock('../../gitlab/pipeline-job-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof PipelineJobMutationsModule>()),
  getJobTrace: getJobTraceMock,
  retryJob: retryJobMock
}))

vi.mock('../../gitlab/issues', async (importOriginal) => ({
  ...(await importOriginal<typeof IssuesModule>()),
  addIssueComment: addIssueCommentMock,
  createIssue: createIssueMock,
  getIssue: getIssueMock,
  listIssues: listIssuesMock
}))

vi.mock('../../gitlab/project-label-and-member-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectLabelAndMemberLookupModule>()),
  listAssignableUsers: listAssignableUsersMock,
  listLabels: listLabelsMock
}))

vi.mock('../../gitlab/issue-update', async (importOriginal) => ({
  ...(await importOriginal<typeof IssueUpdateModule>()),
  updateIssue: updateIssueMock
}))

vi.mock('../../gitlab/merge-request-review-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof MergeRequestReviewMutationsModule>()),
  addMRComment: addMRCommentMock,
  addMRInlineComment: addMRInlineCommentMock,
  resolveMRDiscussion: resolveMRDiscussionMock,
  updateMRReviewers: updateMRReviewersMock
}))

vi.mock('../../gitlab/merge-request-state-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof MergeRequestStateMutationsModule>()),
  closeMR: closeMRMock,
  mergeMR: mergeMRMock,
  reopenMR: reopenMRMock
}))

vi.mock('../../gitlab/merge-request-update', async (importOriginal) => ({
  ...(await importOriginal<typeof MergeRequestUpdateModule>()),
  updateMR: updateMRMock
}))

vi.mock('../../gitlab/merge-request-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof MergeRequestLookupModule>()),
  getMergeRequest: getMergeRequestMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getProjectSlug: getProjectSlugMock
}))

vi.mock('../../gitlab/merge-request-list', async (importOriginal) => ({
  ...(await importOriginal<typeof MergeRequestListModule>()),
  listMergeRequests: listMergeRequestsMock
}))

vi.mock('../../gitlab/work-item-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkItemQueriesModule>()),
  getWorkItemByProjectRef: getWorkItemByProjectRefMock,
  listWorkItems: listWorkItemsMock,
  listTodos: listTodosMock
}))

vi.mock('../../gitlab/gitlab-auth-and-rate-limit', async (importOriginal) => {
  const facadeMocks = await vi.importMock<typeof ClientModule>('../../gitlab/client')
  return {
    ...(await importOriginal<typeof GitlabAuthAndRateLimitModule>()),
    diagnoseAuth: facadeMocks.diagnoseAuth,
    getAuthenticatedViewer: facadeMocks.getAuthenticatedViewer,
    getRateLimit: facadeMocks.getRateLimit
  }
})

vi.mock('../../gitlab/work-item-details', () => ({
  getWorkItemDetails: getWorkItemDetailsMock
}))

vi.mock('../../gitlab/gitlab-project-recents', () => ({
  recordGitLabProjectRecent: vi.fn()
}))

import { registerGitLabHandlers } from './gitlab'

function storeWithRepos(
  repos: Repo[],
  projects: ReturnType<Store['getProjects']> = []
): Pick<Store, 'getRepos' | 'getRepo' | 'getProjects' | 'getSettings'> {
  return {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((candidate) => candidate.id === id),
    getProjects: () => projects,
    getSettings: () =>
      ({
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }) as ReturnType<Store['getSettings']>
  }
}

describe('GitLab IPC handlers', () => {
  beforeEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    ipcHandlers.clear()
    for (const mock of [
      listMergeRequestsMock,
      getIssueMock,
      listIssuesMock,
      createIssueMock,
      updateIssueMock,
      addIssueCommentMock,
      closeMRMock,
      reopenMRMock,
      mergeMRMock,
      updateMRMock,
      updateMRReviewersMock,
      addMRCommentMock,
      addMRInlineCommentMock,
      resolveMRDiscussionMock,
      getJobTraceMock,
      retryJobMock,
      listLabelsMock,
      listAssignableUsersMock,
      listTodosMock,
      listWorkItemsMock,
      getWorkItemDetailsMock,
      getWorkItemByProjectRefMock,
      getMergeRequestMock,
      getMergeRequestForBranchMock,
      getProjectSlugMock
    ]) {
      mock.mockReset()
    }
    readWslDistroRunningStateMock.mockReset().mockResolvedValue('running')
  })

  it('rejects source context for a different host', async () => {
    registerGitLabHandlers(
      storeWithRepos([repo({ id: 'repo-local', path: '/local/orca' })]) as Store
    )

    const handler = ipcHandlers.get('gitlab:listWorkItems')
    await expect(
      handler?.(null, {
        repoPath: '/local/orca',
        repoId: 'repo-local',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'gitlab:stablyai/orca',
          hostId: toSshExecutionHostId('builder'),
          repoId: 'repo-local'
        }
      })
    ).rejects.toThrow('source host does not match')
  })

  // Bound raw CI traces before they exceed the runtime frame cap (#7732).
})
