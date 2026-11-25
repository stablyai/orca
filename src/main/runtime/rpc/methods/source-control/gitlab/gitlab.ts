import { defineMethod } from '../../../core'
import { normalizeGitLabIssueListArgs } from '../../../../../gitlab/requests/gitlab-preload-args'
import { toGitLabJobLogExcerptResult } from '../../../../../../shared/source-control/checks/gitlab/gitlab-job-log-excerpt'
import {
  AddIssueComment,
  AddMRComment,
  AddMRInlineComment,
  CreateIssue,
  EmptyParams,
  GitLabRateLimit,
  IssuesList,
  JobTrace,
  MergeMr,
  MergeRequestsList,
  RepoSelector,
  ResolveMRDiscussion,
  RetryJob,
  UpdateIssue,
  UpdateMr,
  UpdateMrReviewers,
  UpdateMrState,
  WorkItemByPath,
  WorkItemDetails,
  WorkItemsList
} from '../../../../../../shared/rpc-contract/source-control/gitlab-params'

export const GITLAB_METHODS = [
  defineMethod({
    name: 'gitlab.listMRs',
    permission: 'workspace',
    share: 'not-shared',
    params: MergeRequestsList,
    handler: async (params, { runtime }) =>
      runtime.listGitLabRepoMRs(
        params.repo,
        params.state,
        params.page,
        params.perPage,
        params.query,
        params.involvement
      )
  }),
  defineMethod({
    name: 'gitlab.listWorkItems',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listGitLabRepoWorkItems(
        params.repo,
        params.state,
        params.page,
        params.perPage,
        params.query
      )
  }),
  defineMethod({
    name: 'gitlab.listIssues',
    permission: 'workspace',
    share: 'not-shared',
    params: IssuesList,
    handler: async (params, { runtime }) => {
      const normalized = normalizeGitLabIssueListArgs(params)
      return runtime.listGitLabRepoIssues(
        params.repo,
        normalized.state,
        normalized.assignee,
        normalized.limit,
        normalized.page
      )
    }
  }),
  defineMethod({
    name: 'gitlab.todos',
    permission: 'workspace',
    share: 'not-shared',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGitLabRepoTodos(params.repo)
  }),
  defineMethod({
    name: 'gitlab.diagnoseAuth',
    permission: 'workspace',
    share: 'not-shared',
    params: EmptyParams,
    handler: async (_params, { runtime }) => runtime.diagnoseGitLabAuth()
  }),
  defineMethod({
    name: 'gitlab.rateLimit',
    permission: 'workspace',
    share: 'not-shared',
    params: GitLabRateLimit,
    handler: async (params, { runtime }) => runtime.getGitLabRateLimit(params)
  }),
  defineMethod({
    name: 'gitlab.listLabels',
    permission: 'workspace',
    share: 'not-shared',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGitLabRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'gitlab.listAssignableUsers',
    permission: 'workspace',
    share: 'not-shared',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGitLabRepoAssignableUsers(params.repo)
  }),
  defineMethod({
    name: 'gitlab.createIssue',
    permission: 'workspace',
    share: 'not-shared',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.createGitLabRepoIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'gitlab.updateIssue',
    permission: 'workspace',
    share: 'not-shared',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoIssue(params.repo, params.number, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.addIssueComment',
    permission: 'workspace',
    share: 'not-shared',
    params: AddIssueComment,
    handler: async (params, { runtime }) =>
      runtime.addGitLabRepoIssueComment(params.repo, params.number, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.addMRComment',
    permission: 'workspace',
    share: 'not-shared',
    params: AddMRComment,
    handler: async (params, { runtime }) =>
      runtime.addGitLabRepoMRComment(params.repo, params.iid, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.addMRInlineComment',
    permission: 'workspace',
    share: 'not-shared',
    params: AddMRInlineComment,
    handler: async (params, { runtime }) =>
      runtime.addGitLabRepoMRInlineComment(params.repo, params.iid, params.input, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.resolveMRDiscussion',
    permission: 'workspace',
    share: 'not-shared',
    params: ResolveMRDiscussion,
    handler: async (params, { runtime }) =>
      runtime.resolveGitLabRepoMRDiscussion(
        params.repo,
        params.iid,
        params.discussionId,
        params.resolved,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitlab.jobTrace',
    permission: 'workspace',
    share: 'not-shared',
    params: JobTrace,
    handler: async (params, { runtime }) => {
      const result = await runtime.getGitLabRepoJobTrace(
        params.repo,
        params.jobId,
        params.projectRef
      )
      return params.logExcerpt ? toGitLabJobLogExcerptResult(result) : result
    }
  }),
  defineMethod({
    name: 'gitlab.retryJob',
    permission: 'workspace',
    share: 'not-shared',
    params: RetryJob,
    handler: async (params, { runtime }) =>
      runtime.retryGitLabRepoJob(params.repo, params.jobId, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.mergeMR',
    permission: 'workspace',
    share: 'not-shared',
    params: MergeMr,
    handler: async (params, { runtime }) =>
      runtime.mergeGitLabRepoMR(params.repo, params.iid, params.method, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.updateMRState',
    permission: 'workspace',
    share: 'not-shared',
    params: UpdateMrState,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoMRState(params.repo, params.iid, params.state, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.updateMR',
    permission: 'workspace',
    share: 'not-shared',
    params: UpdateMr,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoMR(params.repo, params.iid, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.updateMRReviewers',
    permission: 'workspace',
    share: 'not-shared',
    params: UpdateMrReviewers,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoMRReviewers(
        params.repo,
        params.iid,
        params.reviewerIds,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitlab.workItemDetails',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getGitLabRepoWorkItemDetails(
        params.repo,
        params.iid,
        params.type,
        params.projectRef,
        params.includeReviewDetails,
        params.markViewerComments
      )
  }),
  defineMethod({
    name: 'gitlab.workItemByPath',
    permission: 'workspace',
    share: 'not-shared',
    params: WorkItemByPath,
    handler: async (params, { runtime }) =>
      runtime.getGitLabRepoWorkItemByPath(
        params.repo,
        { host: params.host, path: params.path },
        params.iid,
        params.type
      )
  })
]
