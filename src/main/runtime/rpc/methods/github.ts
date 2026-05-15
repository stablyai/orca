/* eslint-disable max-lines -- Why: GitHub runtime RPC keeps related repo, project, and mutation schemas beside their handlers so the method contract stays reviewable in one place. */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const WorkItemsList = RepoSelector.extend({
  limit: OptionalFiniteNumber,
  query: OptionalString,
  before: OptionalString
})

const WorkItem = RepoSelector.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr']).optional()
})

const WorkItemByOwnerRepo = RepoSelector.extend({
  owner: requiredString('Missing owner'),
  ownerRepo: requiredString('Missing repo'),
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})

const WorkItemDetails = WorkItem

const WorkItemsCount = RepoSelector.extend({
  query: OptionalString
})

const RateLimit = z.object({
  force: z.boolean().optional()
})

const SlugRepo = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo')
})

const SlugAssignableUsers = SlugRepo.extend({
  seedLogins: z.array(z.string()).optional()
})

const PrForBranch = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  linkedPRNumber: z.number().int().positive().nullable().optional()
})

const Issue = RepoSelector.extend({
  number: z.number().int().positive()
})

const PullRequest = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  noCache: z.boolean().optional()
})

const PullRequestChecks = PullRequest.extend({
  headSha: OptionalString
})

const PullRequestFileContents = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  path: requiredString('Missing file path'),
  oldPath: OptionalString,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  headSha: requiredString('Missing head SHA'),
  baseSha: requiredString('Missing base SHA')
})

const ReviewThread = RepoSelector.extend({
  threadId: requiredString('Missing thread ID'),
  resolve: z.boolean()
})

const UpdatePrTitle = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  title: requiredString('Missing title')
})

const MergePr = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional()
})

const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string()
})

const IssueUpdate = z.object({
  state: z.enum(['open', 'closed']).optional(),
  title: OptionalString,
  body: OptionalString,
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  addAssignees: z.array(z.string()).optional(),
  removeAssignees: z.array(z.string()).optional()
})

const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const IssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body required'),
  type: z.enum(['issue', 'pr']).optional()
})

const PRReviewComment = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  commitId: requiredString('Missing PR head SHA'),
  path: requiredString('File path required'),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  body: requiredString('Comment body required')
})

const PRReviewCommentReply = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  commentId: z.number().int().positive(),
  body: requiredString('Comment body required'),
  threadId: OptionalString,
  path: OptionalString,
  line: z.number().int().positive().optional()
})

const ProjectOwnerType = z.enum(['organization', 'user'])

const ProjectViewTable = z.object({
  owner: requiredString('Missing owner'),
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive(),
  viewId: OptionalString,
  viewNumber: z.number().int().positive().optional(),
  viewName: OptionalString,
  queryOverride: OptionalString
})

const ProjectRef = z.object({
  input: requiredString('Missing project reference')
})

const ProjectViews = z.object({
  owner: requiredString('Missing owner'),
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive()
})

const ProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID'),
  value: z.any()
})

const ClearProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID')
})

const SlugIssueUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const SlugPullRequestUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  number: z.number().int().positive(),
  updates: z.object({
    title: OptionalString,
    body: OptionalString
  })
})

const SlugIssueTypeUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  number: z.number().int().positive(),
  issueTypeId: z.string().nullable()
})

const SlugIssueComment = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  number: z.number().int().positive(),
  body: requiredString('Comment body required')
})

const SlugIssueCommentEdit = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  commentId: z.number().int().positive(),
  body: requiredString('Comment body required')
})

const SlugIssueCommentDelete = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  commentId: z.number().int().positive()
})

export const GITHUB_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.repoSlug',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoSlug(params.repo)
  }),
  defineMethod({
    name: 'github.rateLimit',
    params: RateLimit,
    handler: async (params, { runtime }) => runtime.getGitHubRateLimit(params)
  }),
  defineMethod({
    name: 'github.listWorkItems',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listRepoWorkItems(params.repo, params.limit, params.query, params.before)
  }),
  defineMethod({
    name: 'github.countWorkItems',
    params: WorkItemsCount,
    handler: async (params, { runtime }) => runtime.countRepoWorkItems(params.repo, params.query)
  }),
  defineMethod({
    name: 'github.listLabels',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listRepoLabels(params.repo)
  }),
  defineMethod({
    name: 'github.listAssignableUsers',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listRepoAssignableUsers(params.repo)
  }),
  defineMethod({
    name: 'github.workItem',
    params: WorkItem,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItem(params.repo, params.number, params.type)
  }),
  defineMethod({
    name: 'github.workItemByOwnerRepo',
    params: WorkItemByOwnerRepo,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItemByOwnerRepo(
        params.repo,
        { owner: params.owner, repo: params.ownerRepo },
        params.number,
        params.type
      )
  }),
  defineMethod({
    name: 'github.workItemDetails',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getRepoWorkItemDetails(params.repo, params.number, params.type)
  }),
  defineMethod({
    name: 'github.prForBranch',
    params: PrForBranch,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRForBranch(params.repo, params.branch, params.linkedPRNumber)
  }),
  defineMethod({
    name: 'github.issue',
    params: Issue,
    handler: async (params, { runtime }) => runtime.getRepoIssue(params.repo, params.number)
  }),
  defineMethod({
    name: 'github.prChecks',
    params: PullRequestChecks,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRChecks(params.repo, params.prNumber, params.headSha, {
        noCache: params.noCache
      })
  }),
  defineMethod({
    name: 'github.prComments',
    params: PullRequest,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRComments(params.repo, params.prNumber, { noCache: params.noCache })
  }),
  defineMethod({
    name: 'github.prFileContents',
    params: PullRequestFileContents,
    handler: async (params, { runtime }) =>
      runtime.getRepoPRFileContents(params.repo, {
        prNumber: params.prNumber,
        path: params.path,
        oldPath: params.oldPath,
        status: params.status,
        headSha: params.headSha,
        baseSha: params.baseSha
      })
  }),
  defineMethod({
    name: 'github.resolveReviewThread',
    params: ReviewThread,
    handler: async (params, { runtime }) =>
      runtime.resolveRepoReviewThread(params.repo, params.threadId, params.resolve)
  }),
  defineMethod({
    name: 'github.updatePRTitle',
    params: UpdatePrTitle,
    handler: async (params, { runtime }) =>
      runtime.updateRepoPRTitle(params.repo, params.prNumber, params.title)
  }),
  defineMethod({
    name: 'github.mergePR',
    params: MergePr,
    handler: async (params, { runtime }) =>
      runtime.mergeRepoPR(params.repo, params.prNumber, params.method)
  }),
  defineMethod({
    name: 'github.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.createRepoIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'github.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateRepoIssue(params.repo, params.number, params.updates)
  }),
  defineMethod({
    name: 'github.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.addRepoIssueComment(params.repo, params.number, params.body)
  }),
  defineMethod({
    name: 'github.addPRReviewComment',
    params: PRReviewComment,
    handler: async (params, { runtime }) =>
      runtime.addRepoPRReviewComment(params.repo, {
        prNumber: params.prNumber,
        commitId: params.commitId,
        path: params.path,
        line: params.line,
        startLine: params.startLine,
        body: params.body
      })
  }),
  defineMethod({
    name: 'github.addPRReviewCommentReply',
    params: PRReviewCommentReply,
    handler: async (params, { runtime }) =>
      runtime.addRepoPRReviewCommentReply(params.repo, {
        prNumber: params.prNumber,
        commentId: params.commentId,
        body: params.body,
        threadId: params.threadId,
        path: params.path,
        line: params.line
      })
  }),
  defineMethod({
    name: 'github.project.listAccessible',
    params: z.object({}),
    handler: async (_params, { runtime }) => runtime.listGitHubProjects()
  }),
  defineMethod({
    name: 'github.project.listLabelsBySlug',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubLabelsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listAssignableUsersBySlug',
    params: SlugAssignableUsers,
    handler: async (params, { runtime }) => runtime.listGitHubAssignableUsersBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listIssueTypesBySlug',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubIssueTypesBySlug(params)
  }),
  defineMethod({
    name: 'github.project.resolveRef',
    params: ProjectRef,
    handler: async (params, { runtime }) => runtime.resolveGitHubProjectRef(params)
  }),
  defineMethod({
    name: 'github.project.listViews',
    params: ProjectViews,
    handler: async (params, { runtime }) => runtime.listGitHubProjectViews(params)
  }),
  defineMethod({
    name: 'github.project.viewTable',
    params: ProjectViewTable,
    handler: async (params, { runtime }) => runtime.getGitHubProjectViewTable(params)
  }),
  defineMethod({
    name: 'github.project.updateItemField',
    params: ProjectItemField,
    handler: async (params, { runtime }) => runtime.updateGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.clearItemField',
    params: ClearProjectItemField,
    handler: async (params, { runtime }) => runtime.clearGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueBySlug',
    params: SlugIssueUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updatePullRequestBySlug',
    params: SlugPullRequestUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubPullRequestBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueTypeBySlug',
    params: SlugIssueTypeUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueTypeBySlug(params)
  }),
  defineMethod({
    name: 'github.project.addIssueCommentBySlug',
    params: SlugIssueComment,
    handler: async (params, { runtime }) => runtime.addGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueCommentBySlug',
    params: SlugIssueCommentEdit,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.deleteIssueCommentBySlug',
    params: SlugIssueCommentDelete,
    handler: async (params, { runtime }) => runtime.deleteGitHubIssueCommentBySlug(params)
  })
]
