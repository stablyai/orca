import { ipcMain } from 'electron'
import {
  listAssignableUsers,
  listAssignableUsersForProject,
  searchUsers
} from '../../jira/jira-issue-create-metadata'

function normalizeSiteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function registerJiraUserSearchHandlers(): void {
  ipcMain.handle(
    'jira:listAssignableUsers',
    async (_event, args: { key: string; query?: string; siteId?: string }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return []
      }
      return listAssignableUsers(
        args.key.trim(),
        typeof args.query === 'string' ? args.query : undefined,
        normalizeSiteId(args.siteId)
      )
    }
  )

  ipcMain.handle(
    'jira:listAssignableUsersForProject',
    async (_event, args: { projectIdOrKey: string; query?: string; siteId?: string }) => {
      if (typeof args?.projectIdOrKey !== 'string' || !args.projectIdOrKey.trim()) {
        return []
      }
      return listAssignableUsersForProject(
        args.projectIdOrKey.trim(),
        typeof args.query === 'string' ? args.query : undefined,
        normalizeSiteId(args.siteId)
      )
    }
  )

  ipcMain.handle('jira:searchUsers', async (_event, args?: { query?: string; siteId?: string }) => {
    return searchUsers(
      typeof args?.query === 'string' ? args.query : undefined,
      normalizeSiteId(args?.siteId)
    )
  })
}
