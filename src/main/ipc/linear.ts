import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../linear/client'
import { _resetPreflightCache } from './preflight'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './linear-ipc-args'
import { registerLinearIssueHandlers } from './linear-issue-handlers'
import { registerLinearProjectHandlers } from './linear-project-handlers'
import { registerLinearCustomViewHandlers } from './linear-custom-view-handlers'
import { registerLinearTeamHandlers } from './linear-team-handlers'

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

  ipcMain.handle('linear:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  ipcMain.handle('linear:selectWorkspace', async (_event, args: { workspaceId: string }) => {
    const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
    if (!workspaceId) {
      return getStatus()
    }
    return selectWorkspace(workspaceId)
  })

  ipcMain.handle('linear:status', async () => {
    return getStatus()
  })

  ipcMain.handle('linear:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  registerLinearIssueHandlers()
  registerLinearProjectHandlers()
  registerLinearCustomViewHandlers()
  registerLinearTeamHandlers()
}
