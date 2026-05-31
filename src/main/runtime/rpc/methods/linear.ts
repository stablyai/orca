import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const VALID_FILTERS = ['assigned', 'created', 'all', 'completed'] as const
const VALID_CUSTOM_VIEW_MODELS = ['issue', 'project'] as const
const LinearPriority = z.number().int().min(0).max(4).optional()
const LinearLabelIds = z.array(requiredString('Invalid label ID')).optional()

const Connect = z.object({
  apiKey: requiredString('Invalid API key')
})

const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

const ConcreteWorkspaceId = requiredString('Concrete Linear workspace ID is required').refine(
  (value) => value !== 'all',
  'Concrete Linear workspace ID is required'
)

const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

const SearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString
  })
  .optional()

const CreateIssue = z.object({
  teamId: requiredString('Team ID is required'),
  title: requiredString('Title is required'),
  description: OptionalString,
  workspaceId: OptionalString,
  parentIssueId: OptionalString,
  projectId: z.union([z.string(), z.null()]).optional(),
  stateId: OptionalString,
  priority: LinearPriority,
  assigneeId: z.union([z.string(), z.null()]).optional(),
  labelIds: LinearLabelIds
})

const IssueId = z.object({
  id: requiredString('Issue ID is required'),
  workspaceId: OptionalString
})

const IssueComment = z.object({
  issueId: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  workspaceId: OptionalString
})

const ListProjects = z
  .object({
    query: OptionalString,
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString
  })
  .optional()

const ProjectId = z.object({
  id: requiredString('Project ID is required'),
  workspaceId: ConcreteWorkspaceId
})

const ProjectIssues = z.object({
  projectId: requiredString('Project ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId
})

const ListCustomViews = z.object({
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

const CustomViewId = z.object({
  viewId: requiredString('Custom view ID is required'),
  model: z.enum(VALID_CUSTOM_VIEW_MODELS),
  workspaceId: ConcreteWorkspaceId
})

const CustomViewContents = z.object({
  viewId: requiredString('Custom view ID is required'),
  limit: OptionalFiniteNumber,
  workspaceId: ConcreteWorkspaceId
})

const TeamId = z.object({
  teamId: requiredString('Team ID is required'),
  workspaceId: OptionalString
})

const IssueUpdate = z.object({
  id: requiredString('Issue ID is required'),
  workspaceId: OptionalString,
  updates: z.object({
    stateId: OptionalString,
    title: OptionalString,
    description: z.string().optional(),
    assigneeId: z.union([z.string(), z.null()]).optional(),
    estimate: z.union([z.number().int().min(0), z.null()]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labelIds: z.array(z.string()).optional(),
    projectId: z.union([z.string(), z.null()]).optional()
  })
})

export const LINEAR_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'linear.connect',
    params: Connect,
    handler: async (params, { runtime }) => runtime.linearConnect(params.apiKey.trim())
  }),
  defineMethod({
    name: 'linear.disconnect',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearDisconnect(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.selectWorkspace',
    params: SelectWorkspace,
    handler: async (params, { runtime }) => runtime.linearSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'linear.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.linearStatus()
  }),
  defineMethod({
    name: 'linear.testConnection',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearTestConnection(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.linearSearchIssues(params.query, params.limit, params.workspaceId)
  }),
  defineMethod({
    name: 'linear.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.linearListIssues(params?.filter, params?.limit, params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.linearCreateIssue(
        params.teamId.trim(),
        params.title.trim(),
        params.description?.trim() || undefined,
        params.workspaceId,
        params.parentIssueId,
        params.projectId,
        {
          stateId: params.stateId,
          priority: params.priority,
          assigneeId: params.assigneeId,
          labelIds: params.labelIds
        }
      )
  }),
  defineMethod({
    name: 'linear.getIssue',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.linearGetIssue(params.id.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.updateIssue',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.linearUpdateIssue(params.id.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'linear.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.linearAddIssueComment(params.issueId.trim(), params.body.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.issueComments',
    params: z.object({
      issueId: requiredString('Issue ID is required'),
      workspaceId: OptionalString
    }),
    handler: async (params, { runtime }) =>
      runtime.linearIssueComments(params.issueId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.listTeams',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.linearListTeams(params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.listProjects',
    params: ListProjects,
    handler: async (params, { runtime }) =>
      runtime.linearListProjects(params?.query, params?.limit, params?.workspaceId)
  }),
  defineMethod({
    name: 'linear.getProject',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.linearGetProject(params.id.trim(), params.workspaceId.trim())
  }),
  defineMethod({
    name: 'linear.listProjectIssues',
    params: ProjectIssues,
    handler: async (params, { runtime }) =>
      runtime.linearListProjectIssues(
        params.projectId.trim(),
        params.limit,
        params.workspaceId.trim()
      )
  }),
  defineMethod({
    name: 'linear.listCustomViews',
    params: ListCustomViews,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViews(params.model, params.limit, params.workspaceId)
  }),
  defineMethod({
    name: 'linear.getCustomView',
    params: CustomViewId,
    handler: async (params, { runtime }) =>
      runtime.linearGetCustomView(params.viewId.trim(), params.model, params.workspaceId.trim())
  }),
  defineMethod({
    name: 'linear.listCustomViewIssues',
    params: CustomViewContents,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViewIssues(
        params.viewId.trim(),
        params.limit,
        params.workspaceId.trim()
      )
  }),
  defineMethod({
    name: 'linear.listCustomViewProjects',
    params: CustomViewContents,
    handler: async (params, { runtime }) =>
      runtime.linearListCustomViewProjects(
        params.viewId.trim(),
        params.limit,
        params.workspaceId.trim()
      )
  }),
  defineMethod({
    name: 'linear.teamStates',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamStates(params.teamId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.teamLabels',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamLabels(params.teamId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'linear.teamMembers',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.linearTeamMembers(params.teamId.trim(), params.workspaceId)
  })
]
