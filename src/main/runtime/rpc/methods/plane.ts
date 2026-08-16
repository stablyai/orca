import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const InstanceSelection = z.object({ instanceId: OptionalString }).optional()
const Connect = z.object({
  baseUrl: requiredString('Plane base URL is required'),
  workspaceSlug: requiredString('Plane workspace slug is required'),
  apiKey: requiredString('Plane API key is required')
})
const OAuthConnect = z.object({
  baseUrl: requiredString('Plane base URL is required'),
  workspaceSlug: requiredString('Plane workspace slug is required'),
  clientId: requiredString('Plane OAuth client ID is required'),
  clientSecret: requiredString('Plane OAuth client secret is required'),
  scope: OptionalString
})
const SelectInstance = z.object({ instanceId: requiredString('Plane instance ID is required') })
const SearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  instanceId: OptionalString
})
const PlaneListFilter = z.enum(['assigned', 'created', 'all', 'completed', 'open'])
const PlaneIssueQuery = z.object({
  preset: PlaneListFilter.optional(),
  query: OptionalString,
  projectId: OptionalString,
  stateGroup: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']).optional(),
  stateId: OptionalString,
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  assigneeId: OptionalString,
  labelId: OptionalString,
  cycleId: OptionalString,
  moduleId: OptionalString,
  typeId: OptionalString,
  estimatePoint: z
    .union([z.string(), z.number()])
    .transform((value) =>
      typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
        ? Number(value)
        : value
    )
    .optional(),
  orderBy: z
    .enum([
      '-updated_at',
      'updated_at',
      '-created_at',
      'created_at',
      'priority',
      '-priority',
      'state',
      '-state',
      'name',
      '-name',
      'sort_order',
      '-sort_order'
    ])
    .optional()
})
const ListIssues = z
  .object({
    filter: PlaneListFilter.optional(),
    query: PlaneIssueQuery.optional(),
    limit: OptionalFiniteNumber,
    instanceId: OptionalString
  })
  .optional()
const IssueId = z.object({
  id: requiredString('Plane work item ID is required'),
  instanceId: OptionalString
})
const ProjectId = z.object({
  projectId: requiredString('Plane project ID is required'),
  instanceId: OptionalString
})
const EstimatePointValue = z.union([z.string(), z.number()]).optional()
const NullableEstimatePointValue = z.union([z.string(), z.number(), z.null()]).optional()
const CreateIssue = z.object({
  projectId: requiredString('Plane project ID is required'),
  title: requiredString('Title is required'),
  description: OptionalString,
  stateId: OptionalString,
  priority: OptionalString,
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  cycleId: OptionalString,
  estimatePoint: EstimatePointValue,
  typeId: OptionalString,
  moduleId: OptionalString,
  externalSource: OptionalString,
  externalId: OptionalString,
  instanceId: OptionalString
})
const IssueUpdate = z.object({
  id: requiredString('Plane work item ID is required'),
  instanceId: OptionalString,
  updates: z.object({
    title: OptionalString,
    description: z.union([z.string(), z.null()]).optional(),
    stateId: z.union([z.string(), z.null()]).optional(),
    assigneeIds: z.array(z.string()).optional(),
    labelIds: z.array(z.string()).optional(),
    priority: z.union([z.string(), z.null()]).optional(),
    cycleId: z.union([z.string(), z.null()]).optional(),
    estimatePoint: NullableEstimatePointValue,
    typeId: z.union([z.string(), z.null()]).optional(),
    moduleId: z.union([z.string(), z.null()]).optional()
  })
})
const IssueComment = z.object({
  id: requiredString('Plane work item ID is required'),
  body: requiredString('Comment body is required'),
  instanceId: OptionalString
})
const IssueLink = z.object({
  id: requiredString('Plane work item ID is required'),
  title: requiredString('Link title is required'),
  url: requiredString('Link URL is required'),
  instanceId: OptionalString
})

export const PLANE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'plane.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.planeConnect({
        baseUrl: params.baseUrl.trim(),
        workspaceSlug: params.workspaceSlug.trim(),
        apiKey: params.apiKey.trim()
      })
  }),
  defineMethod({
    name: 'plane.connectOAuth',
    params: OAuthConnect,
    handler: async (params, { runtime }) =>
      runtime.planeConnectOAuth({
        baseUrl: params.baseUrl.trim(),
        workspaceSlug: params.workspaceSlug.trim(),
        clientId: params.clientId.trim(),
        clientSecret: params.clientSecret.trim(),
        scope: params.scope?.trim()
      })
  }),
  defineMethod({
    name: 'plane.disconnect',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.planeDisconnect(params?.instanceId)
  }),
  defineMethod({
    name: 'plane.selectInstance',
    params: SelectInstance,
    handler: async (params, { runtime }) => runtime.planeSelectInstance(params.instanceId.trim())
  }),
  defineMethod({
    name: 'plane.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.planeStatus()
  }),
  defineMethod({
    name: 'plane.testConnection',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.planeTestConnection(params?.instanceId)
  }),
  defineMethod({
    name: 'plane.listProjects',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.planeListProjects(params?.instanceId)
  }),
  defineMethod({
    name: 'plane.listStates',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListStates(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.listLabels',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListLabels(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.listMembers',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.planeListMembers(params?.instanceId)
  }),
  defineMethod({
    name: 'plane.listCycles',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListCycles(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.listModules',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListModules(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.listWorkItemTypes',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListWorkItemTypes(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.listEstimates',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListEstimates(params.projectId.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.planeSearchIssues(params.query.trim(), params.limit, params.instanceId)
  }),
  defineMethod({
    name: 'plane.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.planeListIssues(params?.query ?? params?.filter, params?.limit, params?.instanceId)
  }),
  defineMethod({
    name: 'plane.getIssue',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.planeGetIssue(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.planeCreateIssue({
        projectId: params.projectId.trim(),
        title: params.title.trim(),
        description: params.description?.trim(),
        stateId: params.stateId,
        priority: params.priority,
        assigneeIds: params.assigneeIds,
        labelIds: params.labelIds,
        cycleId: params.cycleId,
        estimatePoint: params.estimatePoint,
        typeId: params.typeId,
        moduleId: params.moduleId,
        externalSource: params.externalSource,
        externalId: params.externalId,
        instanceId: params.instanceId
      })
  }),
  defineMethod({
    name: 'plane.updateIssue',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.planeUpdateIssue(params.id.trim(), params.updates, params.instanceId)
  }),
  defineMethod({
    name: 'plane.deleteIssue',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.planeDeleteIssue(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.planeAddIssueComment(params.id.trim(), params.body.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.issueComments',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.planeIssueComments(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.issueLinks',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.planeIssueLinks(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'plane.addIssueLink',
    params: IssueLink,
    handler: async (params, { runtime }) =>
      runtime.planeAddIssueLink(
        params.id.trim(),
        params.title.trim(),
        params.url.trim(),
        params.instanceId
      )
  }),
  defineMethod({
    name: 'plane.issueAttachments',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.planeIssueAttachments(params.id.trim(), params.instanceId)
  })
]
