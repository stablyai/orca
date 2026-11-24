import type {
  ClickUpTaskListFilter,
  ClickUpTaskUpdate
} from '../../../../shared/clickup/clickup-types'
import {
  connect,
  disconnect,
  getStatus,
  selectWorkspace,
  testConnection
} from '../../../clickup/client'
import { addTaskComment, updateTask } from '../../../clickup/clickup-task-mutations'
import {
  getTask,
  getTaskComments,
  listStatuses,
  listTasks,
  searchTasks
} from '../../../clickup/clickup-task-queries'

export class RuntimeClickUpCommands {
  async clickupStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  async clickupConnect(token: string): ReturnType<typeof connect> {
    return connect(token)
  }

  async clickupDisconnect(): Promise<{ ok: true }> {
    await disconnect()
    return { ok: true }
  }

  async clickupSelectWorkspace(workspaceId: string): ReturnType<typeof selectWorkspace> {
    return selectWorkspace(workspaceId)
  }

  async clickupTestConnection(): ReturnType<typeof testConnection> {
    return testConnection()
  }

  async clickupListTasks(
    filter: ClickUpTaskListFilter,
    page: number,
    workspaceId?: string
  ): ReturnType<typeof listTasks> {
    return listTasks(filter, page, workspaceId)
  }

  async clickupSearchTasks(
    query: string,
    filter: ClickUpTaskListFilter,
    fresh: boolean,
    workspaceId?: string
  ): ReturnType<typeof searchTasks> {
    return searchTasks(query, filter, undefined, fresh, workspaceId)
  }

  async clickupGetTask(id: string): ReturnType<typeof getTask> {
    return getTask(id)
  }

  async clickupTaskComments(id: string): ReturnType<typeof getTaskComments> {
    return getTaskComments(id)
  }

  async clickupAddTaskComment(id: string, body: string): ReturnType<typeof addTaskComment> {
    return addTaskComment(id, body)
  }

  async clickupListStatuses(listId: string): ReturnType<typeof listStatuses> {
    return listStatuses(listId)
  }

  async clickupUpdateTask(id: string, updates: ClickUpTaskUpdate): ReturnType<typeof updateTask> {
    return updateTask(id, updates)
  }
}
