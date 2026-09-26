import { ipcMain } from 'electron'
import type { RedmineListFilter } from '../../shared/redmine-types'
import {
  connectRedmineSite,
  disconnectRedmineSite,
  getRedmineStatus,
  redmineReadErrorForCredentials,
  resolveRedmineCredentials,
  testRedmineConnection
} from '../redmine/client'
import { getRedmineIssue, listRedmineIssues, RedmineRequestError } from '../redmine/issues'

export function registerRedmineHandlers(): void {
  ipcMain.handle('redmine:connect', async (_event, args: { siteUrl?: string; apiKey?: string }) => {
    const siteUrl = typeof args?.siteUrl === 'string' ? args.siteUrl.trim() : ''
    const apiKey = typeof args?.apiKey === 'string' ? args.apiKey.trim() : ''
    if (!siteUrl || !apiKey) {
      return {
        ok: false,
        error: { type: 'unknown', message: 'Server URL and API key are required.' }
      }
    }
    const result = await connectRedmineSite(siteUrl, apiKey)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    return { ok: true, site: result.site, viewer: result.viewer }
  })

  ipcMain.handle('redmine:disconnect', async (_event, args?: { siteId?: string }) => {
    if (typeof args?.siteId === 'string') {
      disconnectRedmineSite(args.siteId)
    }
  })

  ipcMain.handle('redmine:status', async () => {
    return getRedmineStatus()
  })

  ipcMain.handle(
    'redmine:testConnection',
    async (_event, args: { siteUrl?: string; apiKey?: string }) => {
      const siteUrl = typeof args?.siteUrl === 'string' ? args.siteUrl.trim() : ''
      const apiKey = typeof args?.apiKey === 'string' ? args.apiKey.trim() : ''
      if (!siteUrl || !apiKey) {
        return {
          ok: false,
          error: { type: 'unknown', message: 'Server URL and API key are required.' }
        }
      }
      const result = await testRedmineConnection(siteUrl, apiKey)
      if (!result.user || result.error) {
        return {
          ok: false,
          error: result.error ?? { type: 'unknown', message: 'Unable to connect.' }
        }
      }
      return { ok: true, user: result.user }
    }
  )

  ipcMain.handle('redmine:listIssues', async (_event, args?: { filter?: RedmineListFilter }) => {
    const creds = resolveRedmineCredentials()
    if (!creds.ok) {
      return {
        items: [],
        totalCount: 0,
        error: redmineReadErrorForCredentials(creds.reason)
      }
    }
    try {
      return await listRedmineIssues(creds.siteUrl, creds.apiKey, args?.filter ?? {})
    } catch (error) {
      if (error instanceof RedmineRequestError) {
        return { items: [], totalCount: 0, error: error.classified }
      }
      throw error
    }
  })

  ipcMain.handle('redmine:getIssue', async (_event, args?: { issueId?: number }) => {
    const creds = resolveRedmineCredentials()
    const issueId = typeof args?.issueId === 'number' ? args.issueId : Number.NaN
    if (!creds.ok) {
      return { issue: null, error: redmineReadErrorForCredentials(creds.reason) }
    }
    if (!Number.isFinite(issueId)) {
      return { issue: null }
    }
    try {
      return { issue: await getRedmineIssue(creds.siteUrl, creds.apiKey, issueId) }
    } catch (error) {
      if (error instanceof RedmineRequestError) {
        return { issue: null, error: error.classified }
      }
      throw error
    }
  })
}
