import type {
  ClickUpComment,
  ClickUpCommentResult,
  ClickUpConnectionStatus,
  ClickUpConnectResult,
  ClickUpMutationResult,
  ClickUpStatusOption,
  ClickUpTask,
  ClickUpTaskListFilter,
  ClickUpTaskPage,
  ClickUpTaskUpdate
} from '../../../shared/clickup/clickup-types'

export type ClickUpApi = {
  connect: (args: { token: string }) => Promise<ClickUpConnectResult>
  disconnect: () => Promise<void>
  selectWorkspace: (args: { workspaceId: string }) => Promise<ClickUpConnectionStatus>
  status: () => Promise<ClickUpConnectionStatus>
  testConnection: () => Promise<ClickUpConnectResult>
  listTasks: (args?: { filter?: ClickUpTaskListFilter; page?: number }) => Promise<ClickUpTaskPage>
  searchTasks: (args: { query: string; filter?: ClickUpTaskListFilter }) => Promise<ClickUpTask[]>
  getTask: (args: { id: string }) => Promise<ClickUpTask | null>
  taskComments: (args: { id: string }) => Promise<ClickUpComment[]>
  addTaskComment: (args: { id: string; body: string }) => Promise<ClickUpCommentResult>
  listStatuses: (args: { listId: string }) => Promise<ClickUpStatusOption[]>
  updateTask: (args: { id: string; updates: ClickUpTaskUpdate }) => Promise<ClickUpMutationResult>
}
