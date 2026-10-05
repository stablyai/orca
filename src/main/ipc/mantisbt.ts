import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../mantisbt/client'
import { _resetPreflightCache } from './preflight'
import { getIssue, listIssues, listProjects } from '../mantisbt/issues'
import type {
  MantisBTConnectArgs,
  MantisBTIssueFilter,
  MantisBTSiteSelection
} from '../../shared/mantisbt-types'

const VALID_FILTERS = new Set<MantisBTIssueFilter>(['assigned', 'reported', 'all'])

function normalizeSiteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSiteSelection(value: unknown): MantisBTSiteSelection | undefined {
  return normalizeSiteId(value)
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

/** Registers every `mantisBT:*` IPC handler on the main process. */
export function registerMantisBTHandlers(): void {
  ipcMain.handle('mantisBT:connect', async (_event, args: MantisBTConnectArgs) => {
    if (typeof args?.siteUrl !== 'string' || typeof args?.apiToken !== 'string') {
      return { ok: false, error: 'Site URL and API token are required.' }
    }
    const result = await connect({
      siteUrl: args.siteUrl,
      apiToken: args.apiToken
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('mantisBT:disconnect', async (_event, args?: { siteId?: string }) => {
    disconnect(normalizeSiteId(args?.siteId))
    _resetPreflightCache()
  })

  ipcMain.handle('mantisBT:selectSite', async (_event, args: { siteId: MantisBTSiteSelection }) => {
    const siteId = normalizeSiteSelection(args?.siteId)
    if (!siteId) {
      return getStatus()
    }
    return selectSite(siteId)
  })

  ipcMain.handle('mantisBT:status', async () => {
    return getStatus()
  })

  ipcMain.handle('mantisBT:testConnection', async (_event, args?: { siteId?: string }) => {
    return testConnection(normalizeSiteId(args?.siteId))
  })

  ipcMain.handle(
    'mantisBT:listIssues',
    async (
      event,
      args?: {
        filter?: MantisBTIssueFilter
        limit?: number
        siteId?: MantisBTSiteSelection
        projectId?: string
        requestId?: string
      }
    ) => {
      const requestedFilter = args?.filter
      const filter =
        requestedFilter !== undefined && VALID_FILTERS.has(requestedFilter)
          ? requestedFilter
          : undefined
      const requestId = normalizeSiteId(args?.requestId)
      return listIssues(
        filter,
        clampLimit(args?.limit),
        normalizeSiteSelection(args?.siteId),
        normalizeSiteId(args?.projectId) ?? null,
        undefined,
        requestId
          ? (issues) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('mantisBT:listIssuesProgress', { requestId, issues })
              }
            }
          : undefined
      )
    }
  )

  ipcMain.handle('mantisBT:getIssue', async (_event, args: { id: string; siteId?: string }) => {
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return null
    }
    return getIssue(args.id.trim(), normalizeSiteId(args.siteId))
  })

  ipcMain.handle(
    'mantisBT:listProjects',
    async (_event, args?: { siteId?: MantisBTSiteSelection }) => {
      return listProjects(normalizeSiteSelection(args?.siteId))
    }
  )
}
