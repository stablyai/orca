import type { IpcRenderer } from 'electron'
import type {
  KanbanConnectResult,
  KanbanConnectionStatus,
  KanbanTaskDetails,
  KanbanTaskFilter,
  KanbanTaskListResult
} from '../../shared/kanban-types'

export type KanbanApi = {
  connect(args: { token: string }): Promise<KanbanConnectResult>
  disconnect(): Promise<void>
  status(): Promise<KanbanConnectionStatus>
  listTasks(args?: { filter?: KanbanTaskFilter }): Promise<KanbanTaskListResult>
  getTask(args: { id: string }): Promise<KanbanTaskDetails | null>
}

export function createKanbanApi(ipc: Pick<IpcRenderer, 'invoke'>): KanbanApi {
  return {
    connect: (args: { token: string }): Promise<KanbanConnectResult> =>
      ipc.invoke('kanban:connect', args),
    disconnect: (): Promise<void> => ipc.invoke('kanban:disconnect'),
    status: (): Promise<KanbanConnectionStatus> => ipc.invoke('kanban:status'),
    listTasks: (args?: { filter?: KanbanTaskFilter }): Promise<KanbanTaskListResult> =>
      ipc.invoke('kanban:listTasks', args),
    getTask: (args: { id: string }): Promise<KanbanTaskDetails | null> =>
      ipc.invoke('kanban:getTask', args)
  }
}
