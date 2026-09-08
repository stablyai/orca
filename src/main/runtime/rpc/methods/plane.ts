import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { PLANE_PRIORITIES } from '../../../../shared/plane-types'

// Why: the IPC boundary clamps its limits, so the RPC boundary must too or a
// remote client can send limit: 0 (an empty list reported as truncated) or a
// negative limit (silently drops the last row).
const boundedLimit = (max: number) => z.coerce.number().int().min(1).max(max).optional()

const WorkspaceScope = z.object({ workspaceId: OptionalString }).optional()

const Connect = z.object({
  baseUrl: requiredString('Plane URL is required'),
  workspaceSlug: requiredString('Workspace slug is required'),
  apiToken: requiredString('API token is required'),
  appUrl: OptionalString
})

const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace is required')
})

// The renderer echoes back a project it read from plane.listProjects; the
// identifier and name only feed display keys and links, never authorization.
const Project = z
  .object({
    id: requiredString('Project id is required'),
    identifier: requiredString('Project identifier is required'),
    name: OptionalString
  })
  // Normalized here so handlers receive a complete PlaneProject, matching what
  // the local IPC path builds.
  .transform((value) => {
    const identifier = value.identifier.trim().toUpperCase()
    return { id: value.id.trim(), identifier, name: value.name?.trim() || identifier }
  })

const ProjectScope = z.object({
  project: Project,
  workspaceId: OptionalString
})

const ListWorkItems = ProjectScope.extend({
  orderBy: OptionalString,
  limit: boundedLimit(250)
})

const GetWorkItem = z.object({
  key: requiredString('Work item key is required'),
  workspaceId: OptionalString,
  project: Project.optional()
})

const SearchWorkItems = z.object({
  search: requiredString('Missing search text'),
  limit: boundedLimit(100),
  projectId: OptionalString,
  workspaceId: OptionalString
})

const WorkItemScope = ProjectScope.extend({
  workItemId: requiredString('Work item id is required')
})

const NullableStringArray = z.union([z.array(z.string()), z.null()]).optional()

const UpdateWorkItem = WorkItemScope.extend({
  updates: z.object({
    title: OptionalString,
    stateId: OptionalString,
    priority: z.enum(PLANE_PRIORITIES).optional(),
    assigneeIds: NullableStringArray,
    labelIds: NullableStringArray,
    targetDate: z.union([z.string(), z.null()]).optional()
  })
})

const AddComment = WorkItemScope.extend({
  body: requiredString('A comment needs some text')
})

const CreateWorkItem = ProjectScope.extend({
  title: requiredString('Title is required'),
  description: OptionalString,
  stateId: OptionalString,
  priority: z.enum(PLANE_PRIORITIES).optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional()
})

const ProjectId = z.object({
  projectId: requiredString('Project id is required'),
  workspaceId: OptionalString
})

/**
 * Registered unconditionally for every build, so `plane.provider.v1` is a
 * STATIC capability advertised by getStatus() automatically — clients gate on
 * it to avoid calling a host that predates the Plane provider.
 */
export const PLANE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'plane.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.planeConnect({
        baseUrl: params.baseUrl.trim(),
        workspaceSlug: params.workspaceSlug.trim(),
        apiToken: params.apiToken.trim(),
        ...(params.appUrl ? { appUrl: params.appUrl.trim() } : {})
      })
  }),
  defineMethod({
    name: 'plane.disconnect',
    params: WorkspaceScope,
    handler: async (params, { runtime }) => runtime.planeDisconnect(params?.workspaceId)
  }),
  defineMethod({
    name: 'plane.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.planeStatus()
  }),
  defineMethod({
    name: 'plane.selectWorkspace',
    params: SelectWorkspace,
    handler: async (params, { runtime }) => runtime.planeSelectWorkspace(params.workspaceId)
  }),
  defineMethod({
    name: 'plane.testConnection',
    params: WorkspaceScope,
    handler: async (params, { runtime }) => runtime.planeTestConnection(params?.workspaceId)
  }),
  defineMethod({
    name: 'plane.listProjects',
    params: WorkspaceScope,
    handler: async (params, { runtime }) => runtime.planeListProjects(params?.workspaceId)
  }),
  defineMethod({
    name: 'plane.listStates',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListStates(params.projectId, params.workspaceId)
  }),
  defineMethod({
    name: 'plane.listLabels',
    params: ProjectId,
    handler: async (params, { runtime }) =>
      runtime.planeListLabels(params.projectId, params.workspaceId)
  }),
  defineMethod({
    name: 'plane.listMembers',
    params: WorkspaceScope,
    handler: async (params, { runtime }) => runtime.planeListMembers(params?.workspaceId)
  }),
  defineMethod({
    name: 'plane.listWorkItems',
    params: ListWorkItems,
    handler: async (params, { runtime }) => runtime.planeListWorkItems(params)
  }),
  defineMethod({
    name: 'plane.getWorkItem',
    params: GetWorkItem,
    handler: async (params, { runtime }) => runtime.planeGetWorkItem(params)
  }),
  defineMethod({
    name: 'plane.searchWorkItems',
    params: SearchWorkItems,
    // Why: search is hit per keystroke. Forwarding the transport signal lets a
    // disconnecting client release the request instead of running it to
    // completion against Plane's 60/minute budget.
    handler: async (params, { runtime, signal }) =>
      runtime.planeSearchWorkItems({ ...params, ...(signal ? { signal } : {}) })
  }),
  defineMethod({
    name: 'plane.workItemComments',
    params: WorkItemScope,
    handler: async (params, { runtime }) => runtime.planeWorkItemComments(params)
  }),
  defineMethod({
    name: 'plane.updateWorkItem',
    params: UpdateWorkItem,
    handler: async (params, { runtime }) => runtime.planeUpdateWorkItem(params)
  }),
  defineMethod({
    name: 'plane.addComment',
    params: AddComment,
    handler: async (params, { runtime }) => runtime.planeAddComment(params)
  }),
  defineMethod({
    name: 'plane.createWorkItem',
    params: CreateWorkItem,
    handler: async (params, { runtime }) => runtime.planeCreateWorkItem(params)
  })
]
