import { registerAppHandler } from '../app-registry/app-handler-registry'
import {
  connect,
  disconnect,
  getStatus,
  selectWorkspace,
  testConnection
} from '../../linear/accounts/linear-account-client'
import { _resetPreflightCache } from '../../preflight/agent-detection'
import { normalizeWorkspaceId, normalizeWorkspaceSelection } from './ipc-args'
import { registerLinearIssueHandlers } from './issue-handlers'
import { registerLinearProjectHandlers } from './project-handlers'
import { registerLinearCustomViewHandlers } from './custom-view-handlers'
import { registerLinearTeamHandlers } from './team-handlers'

export function registerLinearHandlers(): void {
  registerAppHandler('linear:connect', async (_event, args: { apiKey: string }) => {
    if (typeof args?.apiKey !== 'string' || !args.apiKey.trim()) {
      return { ok: false, error: 'Invalid API key' }
    }
    const result = await connect(args.apiKey.trim())
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  registerAppHandler('linear:disconnect', async (_event, args?: { workspaceId?: string }) => {
    await disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  registerAppHandler('linear:selectWorkspace', async (_event, args: { workspaceId: string }) => {
    const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
    if (!workspaceId) {
      return getStatus()
    }
    return selectWorkspace(workspaceId)
  })

  registerAppHandler('linear:status', async () => {
    return getStatus()
  })

  registerAppHandler('linear:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  registerLinearIssueHandlers()
  registerLinearProjectHandlers()
  registerLinearCustomViewHandlers()
  registerLinearTeamHandlers()
}
