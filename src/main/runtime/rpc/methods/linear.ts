import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const VALID_FILTERS = ['assigned', 'created', 'all', 'completed'] as const

const Connect = z.object({
  apiKey: requiredString('Invalid API key')
})

const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

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
  workspaceId: OptionalString
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
    assigneeId: z.union([z.string(), z.null()]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labelIds: z.array(z.string()).optional()
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
        params.workspaceId
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
