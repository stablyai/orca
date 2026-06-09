import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

const VALID_FILTERS = ['assigned', 'all', 'done'] as const

const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

const Connect = z.object({
  apiToken: requiredString('API token is required')
})

const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

const SearchTasks = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

const ListTasks = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString,
    projectId: OptionalString
  })
  .optional()

const TaskId = z.object({
  gid: requiredString('Task id is required'),
  workspaceId: OptionalString
})

const CreateTask = z.object({
  workspaceId: OptionalString,
  projectId: OptionalString,
  title: requiredString('Title is required'),
  notes: OptionalPlainString,
  assigneeGid: OptionalString
})

const TaskUpdate = z.object({
  gid: requiredString('Task id is required'),
  workspaceId: OptionalString,
  updates: z.object({
    title: OptionalString,
    notes: OptionalPlainString,
    completed: z.boolean().optional(),
    assigneeGid: z.union([z.string(), z.null()]).optional(),
    dueOn: z.union([z.string(), z.null()]).optional()
  })
})

const TaskComment = z.object({
  gid: requiredString('Task id is required'),
  text: requiredString('Comment text is required'),
  workspaceId: OptionalString
})

const ProjectSections = z.object({
  projectGid: requiredString('Project is required'),
  workspaceId: OptionalString
})

const AssignableUsers = z
  .object({
    workspaceId: OptionalString,
    query: OptionalPlainString
  })
  .optional()

export const ASANA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'asana.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.asanaConnect({ apiToken: params.apiToken.trim() })
  }),
  defineMethod({
    name: 'asana.disconnect',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.asanaDisconnect(params?.workspaceId)
  }),
  defineMethod({
    name: 'asana.selectWorkspace',
    params: SelectWorkspace,
    handler: async (params, { runtime }) => runtime.asanaSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'asana.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.asanaStatus()
  }),
  defineMethod({
    name: 'asana.testConnection',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.asanaTestConnection(params?.workspaceId)
  }),
  defineMethod({
    name: 'asana.searchTasks',
    params: SearchTasks,
    handler: async (params, { runtime }) =>
      runtime.asanaSearchTasks(params.query, params.limit, params.workspaceId)
  }),
  defineMethod({
    name: 'asana.listTasks',
    params: ListTasks,
    handler: async (params, { runtime }) =>
      runtime.asanaListTasks(params?.filter, params?.limit, params?.workspaceId, params?.projectId)
  }),
  defineMethod({
    name: 'asana.getTask',
    params: TaskId,
    handler: async (params, { runtime }) =>
      runtime.asanaGetTask(params.gid.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'asana.createTask',
    params: CreateTask,
    handler: async (params, { runtime }) =>
      runtime.asanaCreateTask({
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        title: params.title.trim(),
        notes: params.notes,
        assigneeGid: params.assigneeGid
      })
  }),
  defineMethod({
    name: 'asana.updateTask',
    params: TaskUpdate,
    handler: async (params, { runtime }) =>
      runtime.asanaUpdateTask(params.gid.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'asana.addTaskComment',
    params: TaskComment,
    handler: async (params, { runtime }) =>
      runtime.asanaAddTaskComment(params.gid.trim(), params.text.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'asana.taskComments',
    params: TaskId,
    handler: async (params, { runtime }) =>
      runtime.asanaTaskComments(params.gid.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'asana.listProjects',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.asanaListProjects(params?.workspaceId)
  }),
  defineMethod({
    name: 'asana.listSections',
    params: ProjectSections,
    handler: async (params, { runtime }) =>
      runtime.asanaListSections(params.projectGid.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'asana.listAssignableUsers',
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.asanaListAssignableUsers(params?.workspaceId, params?.query)
  })
]
