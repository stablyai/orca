import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const Connect = z.object({
  name: requiredString('Connection name is required'),
  url: requiredString('Huly URL is required'),
  workspace: requiredString('Workspace is required'),
  email: z.string().optional().nullable(),
  secret: requiredString('A token or password is required')
})

const ConnectionId = z
  .object({
    connectionId: OptionalString
  })
  .optional()

const SelectConnection = z.object({
  connectionId: requiredString('Connection ID is required')
})

const ListIssues = z
  .object({
    filter: z.enum(['assigned', 'created', 'all']).optional(),
    limit: OptionalFiniteNumber,
    connectionId: OptionalString
  })
  .optional()

const SearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  connectionId: OptionalString
})

const IssueId = z.object({
  id: requiredString('Issue ID is required'),
  connectionId: OptionalString
})

const CreateIssue = z.object({
  teamId: requiredString('Team ID is required'),
  title: requiredString('Title is required'),
  description: OptionalString,
  priority: z.number().int().min(0).max(4).optional(),
  stateId: OptionalString,
  assigneeId: z.union([z.string(), z.null()]).optional(),
  labelIds: z.array(z.string()).optional(),
  projectId: z.union([z.string(), z.null()]).optional(),
  connectionId: OptionalString
})

const IssueComment = z.object({
  issueId: requiredString('Issue ID is required'),
  body: requiredString('Comment body is required'),
  connectionId: OptionalString
})

const UpdateIssue = z.object({
  id: requiredString('Issue ID is required'),
  connectionId: OptionalString,
  updates: z.object({
    stateId: OptionalString,
    title: OptionalString,
    description: z.string().optional(),
    assigneeId: z.union([z.string(), z.null()]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labelIds: z.array(z.string()).optional()
  })
})

const ListProjects = z
  .object({
    query: OptionalString,
    limit: OptionalFiniteNumber,
    connectionId: OptionalString
  })
  .optional()

const CreateProject = z.object({
  name: requiredString('Project name is required'),
  description: OptionalString,
  connectionId: OptionalString
})

const ProjectId = z.object({
  id: requiredString('Project ID is required'),
  connectionId: OptionalString
})

const ProjectIssues = z.object({
  projectId: requiredString('Project ID is required'),
  limit: OptionalFiniteNumber,
  connectionId: OptionalString
})

const TeamId = z.object({
  teamId: requiredString('Team ID is required'),
  connectionId: OptionalString
})

export const HULY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'huly.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.hulyConnect({
        name: params.name.trim(),
        url: params.url.trim(),
        workspace: params.workspace.trim(),
        email: params.email ?? null,
        secret: params.secret.trim()
      })
  }),
  defineMethod({
    name: 'huly.disconnect',
    params: ConnectionId,
    handler: async (params, { runtime }) => runtime.hulyDisconnect(params?.connectionId)
  }),
  defineMethod({
    name: 'huly.selectConnection',
    params: SelectConnection,
    handler: async (params, { runtime }) => runtime.hulySelectConnection(params.connectionId.trim())
  }),
  defineMethod({
    name: 'huly.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.hulyStatus()
  }),
  defineMethod({
    name: 'huly.preflight',
    params: null,
    handler: async (_params, { runtime }) => runtime.hulyPreflight()
  }),
  defineMethod({
    name: 'huly.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.hulyListIssues(params?.filter, params?.limit, params?.connectionId)
  }),
  defineMethod({
    name: 'huly.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.hulySearchIssues(params.query, params.limit, params.connectionId)
  }),
  defineMethod({
    name: 'huly.getIssue',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.hulyGetIssue(params.id.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) => runtime.hulyCreateIssue(params, params.connectionId)
  }),
  defineMethod({
    name: 'huly.updateIssue',
    params: UpdateIssue,
    handler: async (params, { runtime }) =>
      runtime.hulyUpdateIssue(params.id.trim(), params.updates, params.connectionId)
  }),
  defineMethod({
    name: 'huly.addComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.hulyAddComment(params.issueId.trim(), params.body.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.listComments',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.hulyListComments(params.issueId.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.listProjects',
    params: ListProjects,
    handler: async (params, { runtime }) =>
      runtime.hulyListProjects(params?.query, params?.limit, params?.connectionId)
  }),
  defineMethod({
    name: 'huly.getProject',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.hulyGetProject(params.id.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.createProject',
    params: CreateProject,
    handler: async (params, { runtime }) => runtime.hulyCreateProject(params, params.connectionId)
  }),
  defineMethod({
    name: 'huly.listProjectIssues',
    params: ProjectIssues,
    handler: async (params, { runtime }) =>
      runtime.hulyListProjectIssues(params.projectId.trim(), params.limit, params.connectionId)
  }),
  defineMethod({
    name: 'huly.listTeams',
    params: ConnectionId,
    handler: async (params, { runtime }) => runtime.hulyListTeams(params?.connectionId)
  }),
  defineMethod({
    name: 'huly.teamMembers',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.hulyTeamMembers(params.teamId.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.teamStates',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.hulyTeamStates(params.teamId.trim(), params.connectionId)
  }),
  defineMethod({
    name: 'huly.teamLabels',
    params: TeamId,
    handler: async (params, { runtime }) =>
      runtime.hulyTeamLabels(params.teamId.trim(), params.connectionId)
  })
]
