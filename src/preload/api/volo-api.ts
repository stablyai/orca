import type {
  VoloBoard,
  VoloConnectArgs,
  VoloConnectResult,
  VoloConnectionStatus,
  VoloGoogleLoginResult,
  VoloCreateTaskArgs,
  VoloCreateTaskResult,
  VoloMember,
  VoloMutationResult,
  VoloTask,
  VoloTaskFilter,
  VoloTaskUpdate
} from '../../shared/volo-types'

export type VoloApi = {
  connect: (args: VoloConnectArgs) => Promise<VoloConnectResult>
  connectFromSavedCredentials: () => Promise<VoloConnectResult>
  loginWithGoogle: (args?: { apiUrl?: string }) => Promise<VoloGoogleLoginResult>
  disconnect: () => Promise<{ ok: true }>
  status: () => Promise<VoloConnectionStatus>
  readStatus: () => Promise<VoloConnectionStatus>
  testConnection: () => Promise<VoloConnectResult>
  listBoards: () => Promise<VoloBoard[]>
  listMembers: (args: { boardId: string }) => Promise<VoloMember[]>
  listTasks: (args: { boardId: string; filter?: VoloTaskFilter }) => Promise<VoloTask[]>
  getTask: (args: { taskCode: string }) => Promise<VoloTask | null>
  createTask: (args: VoloCreateTaskArgs) => Promise<VoloCreateTaskResult>
  updateTask: (args: {
    boardId: string
    taskId: string
    updates: VoloTaskUpdate
  }) => Promise<VoloMutationResult>
  moveTask: (args: {
    boardId: string
    taskId: string
    columnId: string
  }) => Promise<VoloMutationResult>
}
