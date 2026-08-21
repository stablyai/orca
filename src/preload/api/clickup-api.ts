import type {
  ClickUpComment,
  ClickUpCommentResult,
  ClickUpConnectionStatus,
  ClickUpCreateTaskArgs,
  ClickUpCreateTaskResult,
  ClickUpList,
  ClickUpMutationResult,
  ClickUpTag,
  ClickUpTask,
  ClickUpTaskFilter,
  ClickUpTaskUpdate,
  ClickUpUser,
  ClickUpViewer,
  ClickUpWorkspaceSelection
} from '../../shared/clickup-types'

export type ClickUpApi = {
  connect: (args: {
    apiToken: string
  }) => Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }>
  disconnect: () => Promise<void>
  selectWorkspace: (args: {
    workspaceId: ClickUpWorkspaceSelection
  }) => Promise<ClickUpConnectionStatus>
  status: () => Promise<ClickUpConnectionStatus>
  testConnection: () => Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }>
  searchTasks: (args: {
    query: string
    limit?: number
    workspaceId?: ClickUpWorkspaceSelection
  }) => Promise<ClickUpTask[]>
  listTasks: (args?: {
    filter?: ClickUpTaskFilter
    limit?: number
    workspaceId?: ClickUpWorkspaceSelection
  }) => Promise<ClickUpTask[]>
  getTask: (args: { taskId: string; workspaceId?: string }) => Promise<ClickUpTask | null>
  createTask: (args: ClickUpCreateTaskArgs) => Promise<ClickUpCreateTaskResult>
  updateTask: (args: {
    taskId: string
    updates: ClickUpTaskUpdate
    workspaceId?: string
  }) => Promise<ClickUpMutationResult>
  addTaskComment: (args: {
    taskId: string
    body: string
    workspaceId?: string
  }) => Promise<ClickUpCommentResult>
  taskComments: (args: { taskId: string; workspaceId?: string }) => Promise<ClickUpComment[]>
  listLists: (args?: { workspaceId?: ClickUpWorkspaceSelection }) => Promise<ClickUpList[]>
  listMembers: (args?: { workspaceId?: string }) => Promise<ClickUpUser[]>
  listTags: (args?: { workspaceId?: string }) => Promise<ClickUpTag[]>
}
