import { ipcMain } from 'electron'
import { connect, disconnect, getStatus } from '../linear/client'
import { getIssue, searchIssues, listIssues } from '../linear/issues'
import type { LinearListFilter } from '../linear/issues'

export function registerLinearHandlers(): void {
  ipcMain.handle('linear:connect', async (_event, args: { apiKey: string }) => {
    return connect(args.apiKey)
  })

  ipcMain.handle('linear:disconnect', async () => {
    disconnect()
  })

  ipcMain.handle('linear:status', async () => {
    return getStatus()
  })

  ipcMain.handle('linear:searchIssues', async (_event, args: { query: string; limit?: number }) => {
    return searchIssues(args.query, args.limit)
  })

  ipcMain.handle(
    'linear:listIssues',
    async (_event, args?: { filter?: LinearListFilter; limit?: number }) => {
      return listIssues(args?.filter, args?.limit)
    }
  )

  ipcMain.handle('linear:getIssue', async (_event, args: { id: string }) => {
    return getIssue(args.id)
  })
}
