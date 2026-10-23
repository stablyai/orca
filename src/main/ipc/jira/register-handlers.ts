import { JiraIssueListFiltersParam } from '../../../shared/rpc-contract/jira-quick-filter-params'
import { JiraFavouriteFilterParams } from '../../../shared/rpc-contract/jira-favourite-filter-params'
import { ipcMain } from 'electron'
import type { JiraMediaFormat } from '../../../shared/jira/jira-attachment-image'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../../jira/client'
import { listFavouriteFilters } from '../../jira/favourite-filters'
import { _resetPreflightCache } from '../../preflight/agent-detection'
import { JiraCancellableRequests } from './cancellable-requests'
import { registerJiraUserSearchHandlers } from './user-search'
import { registerJiraProjectMetadataHandlers } from './project-metadata'
import {
  clampJiraIssueLimit,
  normalizeJiraIssueUpdate,
  normalizeJiraSiteId,
  normalizeJiraSiteSelection
} from './ipc-params'
import { addIssueComment, createIssue, updateIssue } from '../../jira/jira-issue-mutations'
import { getIssue, getIssueSummary } from '../../jira/jira-issue-read'
import { getIssueComments } from '../../jira/jira-issue-comments'
import { getProjectStatusOrder, listTransitions } from '../../jira/jira-transition-queries'
import { listIssues, searchIssues } from '../../jira/jira-issue-search'
import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../../shared/jira-types'

const VALID_FILTERS = new Set<JiraIssueFilter>(['assigned', 'reported', 'all', 'done'])
const issueSummaryRequests = new JiraCancellableRequests()
const searchRequests = new JiraCancellableRequests()

/** Registers every `jira:*` IPC handler on the main process. */
export function registerJiraHandlers(): void {
  ipcMain.handle('jira:connect', async (_event, args: JiraConnectArgs) => {
    if (
      typeof args?.siteUrl !== 'string' ||
      typeof args?.email !== 'string' ||
      typeof args?.apiToken !== 'string'
    ) {
      return { ok: false, error: 'Site URL, email, and API token are required.' }
    }
    const result = await connect({
      siteUrl: args.siteUrl,
      email: args.email,
      apiToken: args.apiToken,
      authType: args.authType === 'server' ? 'server' : 'cloud'
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('jira:disconnect', async (_event, args?: { siteId?: string }) => {
    disconnect(normalizeJiraSiteId(args?.siteId))
    _resetPreflightCache()
  })

  ipcMain.handle('jira:selectSite', async (_event, args: { siteId: JiraSiteSelection }) => {
    const siteId = normalizeJiraSiteSelection(args?.siteId)
    if (!siteId) {
      return getStatus()
    }
    return selectSite(siteId)
  })

  ipcMain.handle('jira:status', async () => getStatus())

  ipcMain.handle('jira:readStatus', async () => getStatus())

  ipcMain.handle('jira:testConnection', async (_event, args?: { siteId?: string }) => {
    return testConnection(normalizeJiraSiteId(args?.siteId))
  })

  ipcMain.handle(
    'jira:searchIssues',
    async (
      _event,
      args: { jql: string; limit?: number; siteId?: JiraSiteSelection; requestId?: string }
    ) => {
      if (typeof args?.jql !== 'string') {
        return []
      }
      return searchRequests.run(args.requestId, (signal) =>
        searchIssues(
          args.jql,
          clampJiraIssueLimit(args.limit),
          normalizeJiraSiteSelection(args.siteId),
          signal
        )
      )
    }
  )

  ipcMain.handle('jira:cancelSearchIssues', (_event, args: { requestId?: string }) => {
    searchRequests.cancel(args?.requestId)
  })

  ipcMain.handle(
    'jira:listIssues',
    async (
      _event,
      args?: {
        filter?: JiraIssueFilter
        limit?: number
        siteId?: JiraSiteSelection
        filters?: JiraIssueListFilters
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as JiraIssueFilter)
        ? (args!.filter as JiraIssueFilter)
        : undefined
      return listIssues(
        filter,
        clampJiraIssueLimit(args?.limit),
        normalizeJiraSiteSelection(args?.siteId),
        false,
        args?.filters ? JiraIssueListFiltersParam.parse(args.filters) : undefined
      )
    }
  )

  ipcMain.handle(
    'jira:getIssue',
    async (_event, args: { key: string; siteId?: string; mediaFormat?: JiraMediaFormat }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return null
      }
      return getIssue(
        args.key.trim(),
        normalizeJiraSiteId(args.siteId),
        false,
        args.mediaFormat === 'reference' ? 'reference' : undefined
      )
    }
  )

  ipcMain.handle(
    'jira:lookupIssueSummary',
    async (_event, args: { key: string; siteId: string; requestId?: string }) => {
      if (
        typeof args?.key !== 'string' ||
        !args.key.trim() ||
        typeof args?.siteId !== 'string' ||
        !args.siteId.trim()
      ) {
        return null
      }
      return issueSummaryRequests.run(args.requestId, (signal) =>
        getIssueSummary(args.key.trim(), args.siteId.trim(), signal)
      )
    }
  )

  ipcMain.handle('jira:cancelIssueSummary', (_event, args: { requestId?: string }) => {
    issueSummaryRequests.cancel(args?.requestId)
  })

  ipcMain.handle('jira:createIssue', async (_event, args: JiraCreateIssueArgs) => {
    if (typeof args?.projectId !== 'string' || !args.projectId.trim()) {
      return { ok: false, error: 'Project is required.' }
    }
    if (typeof args?.issueTypeId !== 'string' || !args.issueTypeId.trim()) {
      return { ok: false, error: 'Issue type is required.' }
    }
    if (typeof args?.title !== 'string' || !args.title.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    return createIssue({
      siteId: normalizeJiraSiteId(args.siteId),
      projectId: args.projectId.trim(),
      issueTypeId: args.issueTypeId.trim(),
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      customFields:
        args.customFields && typeof args.customFields === 'object' ? args.customFields : undefined,
      userFieldKeys: Array.isArray(args.userFieldKeys)
        ? args.userFieldKeys.filter((key): key is string => typeof key === 'string')
        : undefined
    })
  })

  ipcMain.handle(
    'jira:updateIssue',
    async (_event, args: { key: string; updates: JiraIssueUpdate; siteId?: string }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return { ok: false, error: 'Issue key is required.' }
      }
      const updates = normalizeJiraIssueUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateIssue(args.key.trim(), updates, normalizeJiraSiteId(args.siteId))
    }
  )

  ipcMain.handle(
    'jira:addIssueComment',
    async (_event, args: { key: string; body: string; siteId?: string }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return { ok: false, error: 'Issue key is required.' }
      }
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addIssueComment(args.key.trim(), args.body.trim(), normalizeJiraSiteId(args.siteId))
    }
  )

  ipcMain.handle(
    'jira:issueComments',
    async (_event, args: { key: string; siteId?: string; mediaFormat?: JiraMediaFormat }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return []
      }
      return getIssueComments(
        args.key.trim(),
        normalizeJiraSiteId(args.siteId),
        false,
        args.mediaFormat === 'reference' ? 'reference' : undefined
      )
    }
  )

  registerJiraProjectMetadataHandlers(normalizeJiraSiteId)

  ipcMain.handle('jira:listFavouriteFilters', async (_event, args: unknown) => {
    return listFavouriteFilters(JiraFavouriteFilterParams.parse(args).siteId)
  })

  registerJiraUserSearchHandlers()

  ipcMain.handle(
    'jira:listTransitions',
    async (_event, args: { key: string; siteId?: string; strict?: boolean }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return []
      }
      return listTransitions(
        args.key.trim(),
        normalizeJiraSiteId(args.siteId),
        args.strict === true
      )
    }
  )

  ipcMain.handle(
    'jira:getProjectStatusOrder',
    async (_event, args: { projectKey: string; siteId?: string }) => {
      if (typeof args?.projectKey !== 'string' || !args.projectKey.trim()) {
        return { statusIdsByColumn: [] }
      }
      return getProjectStatusOrder(args.projectKey.trim(), normalizeJiraSiteId(args.siteId))
    }
  )
}
