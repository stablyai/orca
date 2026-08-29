import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalPlainString, OptionalString, requiredString } from '../schemas'

const Connect = z.object({
  apiUrl: OptionalPlainString,
  apiToken: requiredString('API token is required'),
  webUrl: OptionalPlainString
})

const BoardId = z.object({
  boardId: requiredString('Board ID is required')
})

const ListTasks = z.object({
  boardId: OptionalString,
  filter: z.enum(['assigned', 'all', 'done']).optional()
})

const TaskCode = z.object({
  taskCode: requiredString('Task code is required')
})

const CreateTask = z.object({
  boardId: requiredString('Board ID is required'),
  title: requiredString('Title is required'),
  columnId: requiredString('Column is required'),
  description: OptionalPlainString,
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  assigneeId: OptionalString
})

const UpdateTask = z.object({
  boardId: requiredString('Board ID is required'),
  taskId: requiredString('Task ID is required'),
  updates: z.object({
    title: OptionalString,
    description: OptionalString,
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    assigneeId: z.union([z.string(), z.null()]).optional()
  })
})

const MoveTask = z.object({
  boardId: requiredString('Board ID is required'),
  taskId: requiredString('Task ID is required'),
  columnId: requiredString('Column is required')
})

export const VOLO_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'volo.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.voloConnect({
        apiToken: params.apiToken.trim(),
        apiUrl: params.apiUrl?.trim(),
        webUrl: params.webUrl?.trim()
      })
  }),
  defineMethod({
    name: 'volo.connectFromSavedCredentials',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloConnectFromSavedCredentials()
  }),
  defineMethod({
    name: 'volo.disconnect',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloDisconnect()
  }),
  defineMethod({
    name: 'volo.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloStatus()
  }),
  defineMethod({
    name: 'volo.readStatus',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloReadStatus()
  }),
  defineMethod({
    name: 'volo.testConnection',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloTestConnection()
  }),
  defineMethod({
    name: 'volo.listBoards',
    params: null,
    handler: async (_params, { runtime }) => runtime.voloListBoards()
  }),
  defineMethod({
    name: 'volo.listMembers',
    params: BoardId,
    handler: async (params, { runtime }) => runtime.voloListMembers(params.boardId.trim())
  }),
  defineMethod({
    name: 'volo.listTasks',
    params: ListTasks,
    handler: async (params, { runtime }) =>
      runtime.voloListTasks(params.boardId?.trim() ?? '', params.filter)
  }),
  defineMethod({
    name: 'volo.getTask',
    params: TaskCode,
    handler: async (params, { runtime }) => runtime.voloGetTask(params.taskCode.trim())
  }),
  defineMethod({
    name: 'volo.createTask',
    params: CreateTask,
    handler: async (params, { runtime }) =>
      runtime.voloCreateTask({
        boardId: params.boardId.trim(),
        title: params.title.trim(),
        columnId: params.columnId.trim(),
        description: params.description?.trim(),
        priority: params.priority,
        assigneeId: params.assigneeId?.trim()
      })
  }),
  defineMethod({
    name: 'volo.updateTask',
    params: UpdateTask,
    handler: async (params, { runtime }) =>
      runtime.voloUpdateTask(params.boardId.trim(), params.taskId.trim(), params.updates)
  }),
  defineMethod({
    name: 'volo.moveTask',
    params: MoveTask,
    handler: async (params, { runtime }) =>
      runtime.voloMoveTask(params.boardId.trim(), params.taskId.trim(), params.columnId.trim())
  })
]
