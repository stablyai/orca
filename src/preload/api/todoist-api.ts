import type {
  TodoistComment,
  TodoistConnectResult,
  TodoistConnectionStatus,
  TodoistMutationResult,
  TodoistTask
} from '../../shared/todoist-types'

export type TodoistApi = {
  connect: (args: { apiToken: string }) => Promise<TodoistConnectResult>
  disconnect: () => Promise<void>
  status: () => Promise<TodoistConnectionStatus>
  /** `query` uses Todoist filter syntax (e.g. "today | overdue"); empty lists all active tasks. */
  listTasks: (args?: { query?: string; limit?: number }) => Promise<TodoistTask[]>
  getComments: (args: { taskId: string }) => Promise<TodoistComment[]>
  closeTask: (args: { id: string }) => Promise<TodoistMutationResult>
}
