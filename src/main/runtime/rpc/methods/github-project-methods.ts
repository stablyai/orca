import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { IssueUpdate } from './github-issue-update-schema'
import { SlugRepo } from './github-repo-target-schemas'

const SlugAssignableUsers = SlugRepo.extend({
  seedLogins: z.array(z.string()).optional()
})

const ProjectOwnerType = z.enum(['organization', 'user'])

const ProjectViewTable = z.object({
  owner: requiredString('Missing owner'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive(),
  viewId: OptionalString,
  viewNumber: z.number().int().positive().optional(),
  viewName: OptionalString,
  queryOverride: OptionalString
})

const ProjectWorkItemDetailsBySlug = SlugRepo.extend({
  number: z.number().int().positive(),
  type: z.enum(['issue', 'pr'])
})

const ProjectRef = z.object({
  input: requiredString('Missing project reference'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString
})

const ProjectViews = z.object({
  owner: requiredString('Missing owner'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  ownerType: ProjectOwnerType,
  projectNumber: z.number().int().positive()
})

const ProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID'),
  value: z.any()
})

const ClearProjectItemField = z.object({
  projectId: requiredString('Missing project ID'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  itemId: requiredString('Missing item ID'),
  fieldId: requiredString('Missing field ID')
})

const SlugIssueUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  updates: IssueUpdate
})

const SlugPullRequestUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  updates: z.object({
    state: z.enum(['open', 'closed']).optional(),
    title: OptionalString,
    body: OptionalString
  })
})

const SlugIssueTypeUpdate = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  issueTypeId: z.string().nullable()
})

const SlugIssueComment = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  number: z.number().int().positive(),
  body: requiredString('Comment body required')
})

const SlugIssueCommentEdit = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  commentId: z.number().int().positive(),
  body: requiredString('Comment body required')
})

const SlugIssueCommentDelete = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString,
  commentId: z.number().int().positive()
})

export const GITHUB_PROJECT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.project.listAccessible',
    params: z.object({ host: OptionalString }),
    handler: async (params, { runtime }) => runtime.listGitHubProjects(params)
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
    name: 'github.project.workItemDetailsBySlug',
    params: ProjectWorkItemDetailsBySlug,
    handler: async (params, { runtime }) => runtime.getGitHubProjectWorkItemDetailsBySlug(params)
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
