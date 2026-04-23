import { ipcMain } from 'electron'
import { connect, disconnect, getStatus } from '../linear/client'
import { _resetPreflightCache } from './preflight'
import { getIssue, searchIssues, listIssues } from '../linear/issues'
import type { LinearListFilter } from '../linear/issues'

const VALID_FILTERS = new Set<LinearListFilter>(['assigned', 'created', 'all', 'completed'])

export function registerLinearHandlers(): void {
  ipcMain.handle('linear:connect', async (_event, args: { apiKey: string }) => {
    if (typeof args?.apiKey !== 'string' || !args.apiKey.trim()) {
      return { ok: false, error: 'Invalid API key' }
    }
    const result = await connect(args.apiKey.trim())
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('linear:disconnect', async () => {
    disconnect()
    _resetPreflightCache()
  })

  ipcMain.handle('linear:status', async () => {
    return getStatus()
  })

  ipcMain.handle('linear:searchIssues', async (_event, args: { query: string; limit?: number }) => {
    if (typeof args?.query !== 'string') {
      return []
    }
    const limit = Math.min(Math.max(1, args.limit ?? 20), 50)
    return searchIssues(args.query, limit)
  })

  ipcMain.handle(
    'linear:listIssues',
    async (_event, args?: { filter?: LinearListFilter; limit?: number }) => {
      const filter = VALID_FILTERS.has(args?.filter as LinearListFilter)
        ? (args!.filter as LinearListFilter)
        : undefined
      const limit = Math.min(Math.max(1, args?.limit ?? 20), 50)
      return listIssues(filter, limit)
    }
  )

  ipcMain.handle('linear:getIssue', async (_event, args: { id: string }) => {
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return null
    }
    return getIssue(args.id.trim())
  })
}
