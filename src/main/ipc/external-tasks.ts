import { ipcMain } from 'electron'
import {
  getExternalTaskProviderStatus,
  getExternalTask,
  listExternalTasks
} from '../external-tasks/client'
import { updateExternalTask } from '../external-tasks/updater'
import { getExternalTaskEditOptions } from '../external-tasks/edit-options'
import type {
  ExternalTaskDetailArgs,
  ExternalTaskListArgs,
  ExternalTaskProvider,
  ExternalTaskUpdateArgs
} from '../../shared/external-task-types'

const providers = new Set<ExternalTaskProvider>(['azure-devops', 'planner', 'ninjaone'])

export function registerExternalTaskHandlers(): void {
  ipcMain.handle('externalTasks:status', async (_event, provider: ExternalTaskProvider) => {
    if (!providers.has(provider)) {
      return { provider, configured: false, authenticated: false, account: null }
    }
    return getExternalTaskProviderStatus(provider)
  })
  ipcMain.handle('externalTasks:list', async (_event, args: ExternalTaskListArgs) => {
    if (!args || !providers.has(args.provider)) {
      return []
    }
    return listExternalTasks(args)
  })
  ipcMain.handle('externalTasks:detail', async (_event, args: ExternalTaskDetailArgs) => {
    if (!args || !providers.has(args.provider) || !args.id) {
      throw new Error('Invalid external task')
    }
    return getExternalTask(args)
  })
  ipcMain.handle('externalTasks:options', async (_event, provider: ExternalTaskProvider) => {
    if (!providers.has(provider)) {
      throw new Error('Invalid external task provider')
    }
    return getExternalTaskEditOptions(provider)
  })
  ipcMain.handle('externalTasks:update', async (_event, args: ExternalTaskUpdateArgs) => {
    if (!args || !providers.has(args.provider) || !args.id) {
      throw new Error('Invalid external task update')
    }
    return updateExternalTask(args)
  })
}
