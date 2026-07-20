import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

const TaskId = z.object({
  taskId: requiredString('Task ID is required'),
  workspaceId: OptionalString
})

const TaskUpdate = z.object({
  taskId: requiredString('Task ID is required'),
  workspaceId: OptionalString,
  updates: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.union([z.number().int().min(1).max(4), z.null()]).optional(),
    dueDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
    timeEstimate: z.union([z.number().nonnegative(), z.null()]).optional(),
    assigneeIds: z.array(z.number()).optional(),
    tagNames: z.array(z.string()).optional()
  })
})

export const CLICKUP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'clickup.connect',
    params: z.object({ apiToken: requiredString('Personal API token is required') }),
    handler: async (params, { runtime }) => runtime.clickUpConnect(params.apiToken.trim())
  }),
  defineMethod({
    name: 'clickup.disconnect',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpDisconnect()
  }),
  defineMethod({
    name: 'clickup.selectWorkspace',
    params: z.object({ workspaceId: requiredString('Workspace ID is required') }),
    handler: async (params, { runtime }) =>
      runtime.clickUpSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'clickup.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpStatus()
  }),
  defineMethod({
    name: 'clickup.testConnection',
    params: null,
    handler: async (_params, { runtime }) => runtime.clickUpTestConnection()
  }),
  defineMethod({
    name: 'clickup.searchTasks',
    params: z.object({
      query: requiredString('Search query is required'),
      limit: OptionalFiniteNumber,
      workspaceId: OptionalString
    }),
    handler: async (params, { runtime }) =>
      runtime.clickUpSearchTasks(params.query, params.limit, params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listTasks',
    params: z
      .object({
        filter: z.enum(['assigned', 'created', 'all', 'completed', 'open']).optional(),
        limit: OptionalFiniteNumber,
        workspaceId: OptionalString
      })
      .optional(),
    handler: async (params, { runtime }) =>
      runtime.clickUpListTasks(params?.filter, params?.limit, params?.workspaceId)
  }),
  defineMethod({
    name: 'clickup.getTask',
    params: TaskId,
    handler: async (params, { runtime }) =>
      runtime.clickUpGetTask(params.taskId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.createTask',
    params: z.object({
      workspaceId: OptionalString,
      listId: requiredString('List is required'),
      name: requiredString('Task name is required'),
      description: z.string().optional(),
      status: OptionalString,
      priority: z.union([z.number().int().min(1).max(4), z.null()]).optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      timeEstimate: z.number().nonnegative().optional(),
      assigneeIds: z.array(z.number()).optional(),
      tagNames: z.array(z.string()).optional(),
      parentTaskId: OptionalString
    }),
    handler: async (params, { runtime }) => runtime.clickUpCreateTask(params)
  }),
  defineMethod({
    name: 'clickup.updateTask',
    params: TaskUpdate,
    handler: async (params, { runtime }) =>
      runtime.clickUpUpdateTask(params.taskId.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.addTaskComment',
    params: z.object({
      taskId: requiredString('Task ID is required'),
      body: requiredString('Comment is required'),
      workspaceId: OptionalString
    }),
    handler: async (params, { runtime }) =>
      runtime.clickUpAddTaskComment(params.taskId.trim(), params.body.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.taskComments',
    params: TaskId,
    handler: async (params, { runtime }) =>
      runtime.clickUpTaskComments(params.taskId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listLists',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListLists(params?.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listMembers',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListMembers(params?.workspaceId)
  }),
  defineMethod({
    name: 'clickup.listTags',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.clickUpListTags(params?.workspaceId)
  })
]
