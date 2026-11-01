import { defineMethod } from '../core'
import {
  AddIssueComment,
  AddPRComment,
  AddPRInlineComment,
  CreateIssue,
  EmptyParams,
  GiteaRateLimit,
  IssuesList,
  JobTrace,
  MarkNotificationRead,
  MergePr,
  PullRequestForBranch,
  PullRequestLookup,
  RepoSelector,
  ResolvePRDiscussion,
  SubmitPRReview,
  UpdateIssue,
  UpdatePr,
  UpdatePrReviewers,
  UpdatePrState,
  WorkItemByPath,
  WorkItemDetails,
  WorkItemsList
} from '../../../../shared/rpc-contract/gitea-params'

export const GITEA_METHODS = [
  defineMethod({
    name: 'gitea.viewer',
    permission: 'workspace',
    params: EmptyParams,
    handler: async (_params, { runtime }) => runtime.getGiteaViewer()
  }),
  defineMethod({
    name: 'gitea.diagnoseAuth',
    permission: 'workspace',
    params: EmptyParams,
    handler: async (_params, { runtime }) => runtime.diagnoseGiteaAuth()
  }),
  defineMethod({
    name: 'gitea.rateLimit',
    permission: 'workspace',
    params: GiteaRateLimit,
    handler: async (params, { runtime }) => runtime.getGiteaRateLimit(params)
  }),
  defineMethod({
    name: 'gitea.projectSlug',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getGiteaProjectRef(params.repo)
  }),
  defineMethod({
    name: 'gitea.prForBranch',
    permission: 'workspace',
    params: PullRequestForBranch,
    handler: async (params, { runtime }) =>
      runtime.getGiteaPullRequestForBranch(params.repo, params.branch, params.linkedPRNumber)
  }),
  defineMethod({
    name: 'gitea.pr',
    permission: 'workspace',
    params: PullRequestLookup,
    handler: async (params, { runtime }) =>
      runtime.getGiteaPullRequestByNumber(params.repo, params.number)
  }),
  defineMethod({
    name: 'gitea.listPRs',
    permission: 'workspace',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listGiteaRepoPRs(params.repo, params.state, params.page, params.perPage, params.query)
  }),
  defineMethod({
    name: 'gitea.listWorkItems',
    permission: 'workspace',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listGiteaRepoWorkItems(
        params.repo,
        params.state,
        params.page,
        params.perPage,
        params.query
      )
  }),
  defineMethod({
    name: 'gitea.issue',
    permission: 'workspace',
    params: PullRequestLookup,
    handler: async (params, { runtime }) => runtime.getGiteaRepoIssue(params.repo, params.number)
  }),
  defineMethod({
    name: 'gitea.listIssues',
    permission: 'workspace',
    params: IssuesList,
    handler: async (params, { runtime }) =>
      runtime.listGiteaRepoIssues(
        params.repo,
        params.state,
        params.assignee,
        params.limit,
        params.page
      )
  }),
  defineMethod({
    name: 'gitea.createIssue',
    permission: 'workspace',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.createGiteaRepoIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'gitea.updateIssue',
    permission: 'workspace',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoIssue(params.repo, params.number, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.addIssueComment',
    permission: 'workspace',
    params: AddIssueComment,
    handler: async (params, { runtime }) =>
      runtime.addGiteaRepoIssueComment(params.repo, params.number, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.listLabels',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'gitea.listAssignableUsers',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoAssignableUsers(params.repo)
  }),
  defineMethod({
    name: 'gitea.notifications',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGiteaRepoNotifications(params.repo)
  }),
  defineMethod({
    name: 'gitea.markNotificationRead',
    permission: 'workspace',
    params: MarkNotificationRead,
    handler: async (params, { runtime }) =>
      runtime.markGiteaRepoNotificationRead(params.repo, params.notificationId)
  }),
  defineMethod({
    name: 'gitea.workItemDetails',
    permission: 'workspace',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getGiteaRepoWorkItemDetails(
        params.repo,
        params.number,
        params.type,
        params.projectRef,
        params.includeReviewDetails
      )
  }),
  defineMethod({
    name: 'gitea.updatePRState',
    permission: 'workspace',
    params: UpdatePrState,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoPRState(params.repo, params.number, params.state, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.mergePR',
    permission: 'workspace',
    params: MergePr,
    handler: async (params, { runtime }) =>
      runtime.mergeGiteaRepoPR(params.repo, params.number, params.method, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.updatePR',
    permission: 'workspace',
    params: UpdatePr,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoPR(params.repo, params.number, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.updatePRReviewers',
    permission: 'workspace',
    params: UpdatePrReviewers,
    handler: async (params, { runtime }) =>
      runtime.updateGiteaRepoPRReviewers(
        params.repo,
        params.number,
        params.reviewerUsernames,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitea.addPRComment',
    permission: 'workspace',
    params: AddPRComment,
    handler: async (params, { runtime }) =>
      runtime.addGiteaRepoPRComment(params.repo, params.number, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.addPRInlineComment',
    permission: 'workspace',
    params: AddPRInlineComment,
    handler: async (params, { runtime }) =>
      runtime.addGiteaRepoPRInlineComment(
        params.repo,
        params.number,
        params.input,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitea.resolvePRDiscussion',
    permission: 'workspace',
    params: ResolvePRDiscussion,
    handler: async (params, { runtime }) =>
      runtime.resolveGiteaRepoPRDiscussion(
        params.repo,
        params.number,
        params.discussionId,
        params.resolved,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitea.submitPRReview',
    permission: 'workspace',
    params: SubmitPRReview,
    handler: async (params, { runtime }) =>
      runtime.submitGiteaRepoPRReview(
        params.repo,
        params.number,
        params.decision,
        params.body,
        params.projectRef
      )
  }),
  defineMethod({
    name: 'gitea.jobTrace',
    permission: 'workspace',
    params: JobTrace,
    handler: async (params, { runtime }) =>
      runtime.getGiteaRepoJobTrace(params.repo, params.jobId, params.projectRef)
  }),
  defineMethod({
    name: 'gitea.workItemByPath',
    permission: 'workspace',
    params: WorkItemByPath,
    handler: async (params, { runtime }) =>
      runtime.getGiteaRepoWorkItemByPath(
        params.repo,
        { host: params.host, path: params.path },
        params.number,
        params.type
      )
  })
]
