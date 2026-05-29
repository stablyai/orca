import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { normalizeGitLabIssueListArgs } from '../../../gitlab/gitlab-preload-args'

const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

const GitLabProjectRef = z
  .object({
    host: requiredString('Missing GitLab host'),
    path: requiredString('Missing GitLab project path')
  })
  .optional()

const WorkItemsList = RepoSelector.extend({
  state: z.enum(['opened', 'merged', 'closed', 'all']).optional(),
  page: OptionalFiniteNumber,
  perPage: OptionalFiniteNumber,
  query: OptionalString
})

const IssuesList = RepoSelector.extend({
  state: z.unknown().optional(),
  assignee: OptionalString,
  limit: OptionalFiniteNumber
})

const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string()
})

const IssueUpdate = z.object({
  state: z.enum(['opened', 'closed']).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  addAssignees: z.array(z.string()).optional(),
  removeAssignees: z.array(z.string()).optional()
})

const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate,
  projectRef: GitLabProjectRef
})

const UpdateMrState = RepoSelector.extend({
  iid: z.number().int().positive(),
  state: z.enum(['opened', 'closed']),
  projectRef: GitLabProjectRef
})

const UpdateMr = RepoSelector.extend({
  iid: z.number().int().positive(),
  updates: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    addLabels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional()
  }),
  projectRef: GitLabProjectRef
})

const MergeMr = RepoSelector.extend({
  iid: z.number().int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
  projectRef: GitLabProjectRef
})

const AddIssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

const AddMRComment = RepoSelector.extend({
  iid: z.number().int().positive(),
  body: requiredString('Comment body is required'),
  projectRef: GitLabProjectRef
})

const WorkItemDetails = RepoSelector.extend({
  iid: z.number().int().positive(),
  type: z.enum(['issue', 'mr']),
  projectRef: GitLabProjectRef
})

const WorkItemByPath = RepoSelector.extend({
  host: requiredString('Missing GitLab host'),
  path: requiredString('Missing GitLab project path'),
  iid: z.number().int().positive(),
  type: z.enum(['issue', 'mr'])
})

export const GITLAB_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'gitlab.listMRs',
    params: WorkItemsList,
    handler: async (params, { runtime }) =>
      runtime.listGitLabRepoMRs(
        params.repo,
        params.state,
        params.page,
        params.perPage,
        params.query
      )
  }),
  defineMethod({
    name: 'gitlab.listWorkItems',
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
    params: IssuesList,
    handler: async (params, { runtime }) => {
      const normalized = normalizeGitLabIssueListArgs(params)
      return runtime.listGitLabRepoIssues(
        params.repo,
        normalized.state,
        normalized.assignee,
        normalized.limit
      )
    }
  }),
  defineMethod({
    name: 'gitlab.todos',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.listGitLabRepoTodos(params.repo)
  }),
  defineMethod({
    name: 'gitlab.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.createGitLabRepoIssue(params.repo, params.title, params.body)
  }),
  defineMethod({
    name: 'gitlab.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoIssue(params.repo, params.number, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.addIssueComment',
    params: AddIssueComment,
    handler: async (params, { runtime }) =>
      runtime.addGitLabRepoIssueComment(params.repo, params.number, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.addMRComment',
    params: AddMRComment,
    handler: async (params, { runtime }) =>
      runtime.addGitLabRepoMRComment(params.repo, params.iid, params.body, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.mergeMR',
    params: MergeMr,
    handler: async (params, { runtime }) =>
      runtime.mergeGitLabRepoMR(params.repo, params.iid, params.method, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.updateMRState',
    params: UpdateMrState,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoMRState(params.repo, params.iid, params.state, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.updateMR',
    params: UpdateMr,
    handler: async (params, { runtime }) =>
      runtime.updateGitLabRepoMR(params.repo, params.iid, params.updates, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.workItemDetails',
    params: WorkItemDetails,
    handler: async (params, { runtime }) =>
      runtime.getGitLabRepoWorkItemDetails(params.repo, params.iid, params.type, params.projectRef)
  }),
  defineMethod({
    name: 'gitlab.workItemByPath',
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
