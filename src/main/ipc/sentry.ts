import { ipcMain } from 'electron'
import type { SentryIssueQuery, SentryIssueUpdate } from '../../shared/sentry-types'
import {
  connectSentry,
  disconnectSentry,
  getSentryIssue,
  getSentryStatus,
  listSentryAssignees,
  listSentryEnvironments,
  listSentryEvents,
  listSentryIssues,
  listSentryProjects,
  selectSentryOrganization,
  testSentryConnection,
  updateSentryIssue
} from '../sentry/service'

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function issueQuery(value: unknown): SentryIssueQuery {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const input = value as Record<string, unknown>
  const strings = (candidate: unknown): string[] | undefined =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : undefined
  return {
    query: typeof input.query === 'string' ? input.query : undefined,
    projects: strings(input.projects),
    environments: strings(input.environments),
    statsPeriod: nonEmptyString(input.statsPeriod) ?? undefined,
    sort:
      input.sort === 'date' ||
      input.sort === 'freq' ||
      input.sort === 'inbox' ||
      input.sort === 'new' ||
      input.sort === 'recommended' ||
      input.sort === 'trends' ||
      input.sort === 'user'
        ? input.sort
        : undefined,
    cursor: nonEmptyString(input.cursor) ?? undefined,
    limit: typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : undefined
  }
}

function issueUpdate(value: unknown): SentryIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  const result: SentryIssueUpdate = {}
  if (input.status !== undefined) {
    if (
      input.status !== 'resolved' &&
      input.status !== 'unresolved' &&
      input.status !== 'ignored'
    ) {
      return null
    }
    result.status = input.status
  }
  if (input.priority !== undefined) {
    if (input.priority !== 'low' && input.priority !== 'medium' && input.priority !== 'high') {
      return null
    }
    result.priority = input.priority
  }
  if (input.assignedTo !== undefined) {
    if (input.assignedTo !== null && typeof input.assignedTo !== 'string') {
      return null
    }
    result.assignedTo = input.assignedTo
  }
  return Object.keys(result).length ? result : null
}

export function registerSentryHandlers(): void {
  ipcMain.handle('sentry:connect', (_event, args: Record<string, unknown>) => {
    const baseUrl = nonEmptyString(args?.baseUrl)
    const token = nonEmptyString(args?.token)
    if (!baseUrl || !token) {
      return { ok: false, error: 'Base URL and auth token are required.' }
    }
    return connectSentry({
      baseUrl,
      token,
      organizationSlug: nonEmptyString(args.organizationSlug) ?? undefined
    })
  })
  ipcMain.handle('sentry:disconnect', () => disconnectSentry())
  ipcMain.handle('sentry:selectOrganization', (_event, args: Record<string, unknown>) => {
    const slug = nonEmptyString(args?.slug)
    return slug ? selectSentryOrganization(slug) : getSentryStatus()
  })
  ipcMain.handle('sentry:status', () => getSentryStatus())
  ipcMain.handle('sentry:testConnection', () => testSentryConnection())
  ipcMain.handle('sentry:listProjects', () => listSentryProjects())
  ipcMain.handle('sentry:listEnvironments', () => listSentryEnvironments())
  ipcMain.handle('sentry:listAssignees', () => listSentryAssignees())
  ipcMain.handle('sentry:listIssues', (_event, args?: unknown) =>
    listSentryIssues(issueQuery(args))
  )
  ipcMain.handle('sentry:getIssue', (_event, args: Record<string, unknown>) => {
    const issueId = nonEmptyString(args?.issueId)
    return issueId ? getSentryIssue(issueId) : null
  })
  ipcMain.handle('sentry:listEvents', (_event, args: Record<string, unknown>) => {
    const issueId = nonEmptyString(args?.issueId)
    if (!issueId) {
      return { items: [], nextCursor: null, previousCursor: null }
    }
    return listSentryEvents(issueId, nonEmptyString(args.cursor) ?? undefined)
  })
  ipcMain.handle('sentry:updateIssue', (_event, args: Record<string, unknown>) => {
    const issueId = nonEmptyString(args?.issueId)
    const updates = issueUpdate(args?.updates)
    if (!issueId || !updates) {
      return { ok: false, error: 'Issue ID and updates are required.' }
    }
    return updateSentryIssue(issueId, updates)
  })
}
