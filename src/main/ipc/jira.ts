import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../jira/client'
import { _resetPreflightCache } from './preflight'
import {
  addIssueComment,
  createIssue,
  getIssue,
  getIssueComments,
  getProjectStatusOrder,
  listAssignableUsers,
  listCreateFields,
  listIssueTypes,
  listIssues,
  listPriorities,
  listProjects,
  listTransitions,
  searchIssues,
  updateIssue
} from '../jira/issues'
import type {
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueUpdate,
  JiraSiteSelection
} from '../../shared/types'

const VALID_FILTERS = new Set<JiraIssueFilter>(['assigned', 'reported', 'all', 'done'])

function normalizeSiteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeSiteSelection(value: unknown): JiraSiteSelection | undefined {
  const siteId = normalizeSiteId(value)
  return siteId as JiraSiteSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function normalizeIssueUpdate(value: unknown): JiraIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as JiraIssueUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.labels !== undefined && normalizeStringArray(input.labels) === undefined) {
    return null
  }
  if (
    input.assigneeAccountId !== undefined &&
    input.assigneeAccountId !== null &&
    typeof input.assigneeAccountId !== 'string'
  ) {
    return null
  }
  if (
    input.priorityId !== undefined &&
    input.priorityId !== null &&
    typeof input.priorityId !== 'string'
  ) {
    return null
  }
  if (input.transitionId !== undefined && typeof input.transitionId !== 'string') {
    return null
  }
  return input
}

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
      apiToken: args.apiToken
    })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('jira:disconnect', async (_event, args?: { siteId?: string }) => {
    disconnect(normalizeSiteId(args?.siteId))
    _resetPreflightCache()
  })

  ipcMain.handle('jira:selectSite', async (_event, args: { siteId: JiraSiteSelection }) => {
    const siteId = normalizeSiteSelection(args?.siteId)
    if (!siteId) {
      return getStatus()
    }
    return selectSite(siteId)
  })

  ipcMain.handle('jira:status', async () => {
    return getStatus()
  })

  ipcMain.handle('jira:testConnection', async (_event, args?: { siteId?: string }) => {
    return testConnection(normalizeSiteId(args?.siteId))
  })

  ipcMain.handle(
    'jira:searchIssues',
    async (_event, args: { jql: string; limit?: number; siteId?: JiraSiteSelection }) => {
      if (typeof args?.jql !== 'string') {
        return []
      }
      return searchIssues(args.jql, clampLimit(args.limit), normalizeSiteSelection(args.siteId))
    }
  )

  ipcMain.handle(
    'jira:listIssues',
    async (
      _event,
      args?: { filter?: JiraIssueFilter; limit?: number; siteId?: JiraSiteSelection }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as JiraIssueFilter)
        ? (args!.filter as JiraIssueFilter)
        : undefined
      return listIssues(filter, clampLimit(args?.limit), normalizeSiteSelection(args?.siteId))
    }
  )

  ipcMain.handle('jira:getIssue', async (_event, args: { key: string; siteId?: string }) => {
    if (typeof args?.key !== 'string' || !args.key.trim()) {
      return null
    }
    return getIssue(args.key.trim(), normalizeSiteId(args.siteId))
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
      siteId: normalizeSiteId(args.siteId),
      projectId: args.projectId.trim(),
      issueTypeId: args.issueTypeId.trim(),
      title: args.title.trim(),
      description: args.description?.trim() || undefined,
      customFields:
        args.customFields && typeof args.customFields === 'object' ? args.customFields : undefined
    })
  })

  ipcMain.handle(
    'jira:updateIssue',
    async (_event, args: { key: string; updates: JiraIssueUpdate; siteId?: string }) => {
      if (typeof args?.key !== 'string' || !args.key.trim()) {
        return { ok: false, error: 'Issue key is required.' }
      }
      const updates = normalizeIssueUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateIssue(args.key.trim(), updates, normalizeSiteId(args.siteId))
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
      return addIssueComment(args.key.trim(), args.body.trim(), normalizeSiteId(args.siteId))
    }
  )

  ipcMain.handle('jira:issueComments', async (_event, args: { key: string; siteId?: string }) => {
    if (typeof args?.key !== 'string' || !args.key.trim()) {
      return []
    }
    return getIssueComments(args.key.trim(), normalizeSiteId(args.siteId))
  })

  ipcMain.handle('jira:listProjects', async (_event, args?: { siteId?: JiraSiteSelection }) => {
    return listProjects(normalizeSiteSelection(args?.siteId))
  })

  ipcMain.handle(
    'jira:listIssueTypes',
    async (_event, args: { projectIdOrKey: string; siteId?: string }) => {
      if (typeof args?.projectIdOrKey !== 'string' || !args.projectIdOrKey.trim()) {
        return []
      }
      return listIssueTypes(args.projectIdOrKey.trim(), normalizeSiteId(args.siteId))
    }
  )

  ipcMain.handle(
    'jira:listCreateFields',
    async (_event, args: { projectIdOrKey: string; issueTypeId: string; siteId?: string }) => {
      if (typeof args?.projectIdOrKey !== 'string' || !args.projectIdOrKey.trim()) {
        return []
      }
      if (typeof args?.issueTypeId !== 'string' || !args.issueTypeId.trim()) {
        return []
      }
      return listCreateFields(
        args.projectIdOrKey.trim(),
        args.issueTypeId.trim(),
        normalizeSiteId(args.siteId)
      )
    }
  )

  ipcMain.handle('jira:listPriorities', async (_event, args?: { siteId?: string }) => {
    return listPriorities(normalizeSiteId(args?.siteId))
  })

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

  ipcMain.handle('jira:listTransitions', async (_event, args: { key: string; siteId?: string }) => {
    if (typeof args?.key !== 'string' || !args.key.trim()) {
      return []
    }
    return listTransitions(args.key.trim(), normalizeSiteId(args.siteId))
  })

  ipcMain.handle(
    'jira:getProjectStatusOrder',
    async (_event, args: { projectKey: string; siteId?: string }) => {
      if (typeof args?.projectKey !== 'string' || !args.projectKey.trim()) {
        return { statusIdsByColumn: [] }
      }
      return getProjectStatusOrder(args.projectKey.trim(), normalizeSiteId(args.siteId))
    }
  )
}
