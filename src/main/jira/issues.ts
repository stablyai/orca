/* eslint-disable max-lines -- Why: Jira task reads and mutations share ADF
   mapping, multi-site fan-out, and auth-clearing behavior; keeping the API
   boundary together avoids subtle drift between operations. */
import type {
  JiraComment,
  JiraCreateField,
  JiraCreateFieldAllowedValue,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSite,
  JiraSiteSelection,
  JiraStatus,
  JiraTransition,
  JiraUser
} from '../../shared/types'
import {
  boundedIntegrationErrorLog,
  boundedIntegrationErrorMessage
} from '../integration-error-message'
import {
  INTEGRATION_PAGINATION_MAX_ITEMS,
  IntegrationPaginationBudget,
  INTEGRATION_PAGINATION_MAX_PAGES
} from '../integration-pagination-budget'
import { runBoundedIntegrationFanout } from '../integration-fanout'
import {
  acquire,
  apiBasePath,
  clearToken,
  getClients,
  isAuthError,
  jiraRequest,
  release,
  type JiraClientForSite
} from './client'
import { adfToMarkdownText, textToAdf } from './adf-markdown'

const ISSUE_FIELDS = [
  'summary',
  'description',
  'project',
  'issuetype',
  'status',
  'assignee',
  'reporter',
  'priority',
  'labels',
  'created',
  'updated'
]

type JiraRecord = Record<string, unknown>

type JiraSearchResponse = {
  issues?: JiraRecord[]
}

type JiraPagedResponse<T> = {
  startAt?: number
  maxResults?: number
  total?: number
  isLast?: boolean
  values?: T[]
  issueTypes?: T[]
  comments?: T[]
  fields?: T[] | Record<string, T>
}

type JiraPageItemKey = 'values' | 'issueTypes' | 'comments'

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

type JiraIssueSearchFailure = {
  error: unknown
  auth: boolean
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function toIssueSearchFailureError(error: unknown): Error {
  const status = getErrorStatus(error)
  const message = boundedIntegrationErrorMessage(error)
  if (status === null || message.startsWith(`Error ${status}:`)) {
    return new Error(message)
  }
  return new Error(boundedIntegrationErrorMessage(`Error ${status}: ${message}`))
}

function shouldSurfaceSiteFailure(
  selection: JiraSiteSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all' choice;
  // multi-entry reads need the same resilient fan-out policy as explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}

function asRecord(value: unknown): JiraRecord {
  return value && typeof value === 'object' ? (value as JiraRecord) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asIdentifier(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getPageItems<T>(response: JiraPagedResponse<T>, key: JiraPageItemKey): T[] {
  const keyedItems = response[key]
  if (Array.isArray(keyedItems)) {
    return keyedItems
  }
  return response.values ?? []
}

function shouldFetchNextPage<T>(
  response: JiraPagedResponse<T>,
  startAt: number,
  items: T[],
  requestedMaxResults: number
): boolean {
  if (response.isLast === true || items.length === 0) {
    return false
  }
  const total = asFiniteNumber(response.total)
  const pageSize = asFiniteNumber(response.maxResults)
  if (total !== null) {
    return startAt + items.length < total && (pageSize ?? requestedMaxResults) > 0
  }
  if (response.isLast === false) {
    return (pageSize ?? requestedMaxResults) > 0
  }
  return pageSize !== null && items.length >= pageSize
}

async function fetchPagedRecords(
  entry: JiraClientForSite,
  key: JiraPageItemKey,
  pathForPage: (startAt: number, maxResults: number) => string,
  maxResults = 100
): Promise<JiraRecord[]> {
  const records: JiraRecord[] = []
  const budget = new IntegrationPaginationBudget()
  let startAt = 0
  for (let guard = 0; guard < INTEGRATION_PAGINATION_MAX_PAGES; guard += 1) {
    const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      pathForPage(startAt, maxResults)
    )
    const items = getPageItems(response, key)
    if (!budget.admitPage(items)) {
      console.warn('[jira] Paginated result exceeded its retained result budget; truncating.')
      break
    }
    for (const item of items) {
      records.push(item)
    }
    if (!shouldFetchNextPage(response, startAt, items, maxResults)) {
      break
    }
    if (!budget.canRequestPage) {
      console.warn('[jira] Paginated result reached its retained result budget; truncating.')
      break
    }
    startAt += asFiniteNumber(response.maxResults) ?? maxResults
  }
  return records
}

function avatarUrl(value: unknown): string | undefined {
  const avatars = asRecord(value)
  return (
    asString(avatars['48x48']) ||
    asString(avatars['32x32']) ||
    asString(avatars['24x24']) ||
    undefined
  )
}

function mapUser(value: unknown): JiraUser | undefined {
  const user = asRecord(value)
  // Server/DC users have no accountId; name (login) and key are its stable ids.
  const accountId = asString(user.accountId) || asString(user.name) || asString(user.key)
  if (!accountId) {
    return undefined
  }
  return {
    accountId,
    displayName: asString(user.displayName, 'Unknown'),
    email: typeof user.emailAddress === 'string' ? user.emailAddress : undefined,
    avatarUrl: avatarUrl(user.avatarUrls)
  }
}

function mapProject(value: unknown, site?: JiraSite): JiraProject {
  const project = asRecord(value)
  return {
    id: asString(project.id),
    key: asString(project.key),
    name: asString(project.name, asString(project.key)),
    siteId: site?.id,
    siteName: site?.displayName
  }
}

function mapIssueType(value: unknown): JiraIssueType {
  const issueType = asRecord(value)
  return {
    id: asString(issueType.id),
    name: asString(issueType.name, 'Issue'),
    description: asString(issueType.description) || undefined,
    iconUrl: asString(issueType.iconUrl) || undefined,
    subtask: typeof issueType.subtask === 'boolean' ? issueType.subtask : undefined
  }
}

function mapCreateFieldAllowedValue(value: unknown): JiraCreateFieldAllowedValue {
  const option = asRecord(value)
  return {
    id: asString(option.id) || undefined,
    value: asString(option.value) || undefined,
    name: asString(option.name) || undefined
  }
}

function mapCreateField(value: unknown, fallbackKey = ''): JiraCreateField | null {
  const field = asRecord(value)
  const schema = asRecord(field.schema)
  const key =
    asString(field.key) ||
    asString(field.fieldId) ||
    asString(field.id) ||
    asString(field.fieldKey) ||
    fallbackKey
  if (!key) {
    return null
  }
  const allowedValues = Array.isArray(field.allowedValues)
    ? field.allowedValues.map(mapCreateFieldAllowedValue)
    : undefined
  return {
    key,
    name: asString(field.name, key),
    required: field.required === true,
    schema: {
      type: asString(schema.type) || undefined,
      items: asString(schema.items) || undefined,
      custom: asString(schema.custom) || undefined
    },
    allowedValues
  }
}

function getCreateFieldRecords(response: JiraPagedResponse<JiraRecord>): JiraRecord[] {
  if (Array.isArray(response.values)) {
    return response.values
  }
  if (Array.isArray(response.fields)) {
    return response.fields
  }
  if (response.fields && typeof response.fields === 'object') {
    return Object.entries(response.fields).map(([key, value]) => ({
      key,
      ...asRecord(value)
    }))
  }
  return []
}

function mapPriority(value: unknown): JiraPriority | undefined {
  const priority = asRecord(value)
  const id = asString(priority.id)
  if (!id) {
    return undefined
  }
  return {
    id,
    name: asString(priority.name, 'Priority'),
    iconUrl: asString(priority.iconUrl) || undefined
  }
}

function mapStatus(value: unknown): JiraStatus {
  const status = asRecord(value)
  const category = asRecord(status.statusCategory)
  return {
    id: asString(status.id),
    name: asString(status.name, 'Unknown'),
    categoryKey: asString(category.key, 'undefined'),
    categoryName: asString(category.name, 'No Category'),
    colorName: asString(category.colorName) || undefined
  }
}

function issueUrl(site: JiraSite, key: string): string {
  return `${site.siteUrl}/browse/${encodeURIComponent(key)}`
}

// REST v2 (Server/DC) bodies are plain text; v3 (Cloud) requires ADF documents.
function toBodyText(site: JiraSite, text: string): unknown {
  return site.authType === 'server' ? text : textToAdf(text)
}

export function mapJiraIssue(site: JiraSite, raw: JiraRecord): JiraIssue {
  const fields = asRecord(raw.fields)
  const key = asString(raw.key)
  return {
    id: asString(raw.id, key),
    key,
    siteId: site.id,
    siteName: site.displayName,
    title: asString(fields.summary, key || 'Untitled issue'),
    description: adfToMarkdownText(fields.description),
    url: issueUrl(site, key),
    project: mapProject(fields.project, site),
    issueType: mapIssueType(fields.issuetype),
    status: mapStatus(fields.status),
    labels: asStringArray(fields.labels),
    assignee: mapUser(fields.assignee),
    reporter: mapUser(fields.reporter),
    priority: mapPriority(fields.priority),
    createdAt: asString(fields.created, new Date().toISOString()),
    updatedAt: asString(fields.updated, new Date().toISOString())
  }
}

function sortAndLimitIssues(issues: JiraIssue[], limit: number): JiraIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function filterToJql(filter: JiraIssueFilter): string {
  if (filter === 'assigned') {
    return 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'reported') {
    return 'reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  }
  if (filter === 'done') {
    return 'assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC'
  }
  return 'resolution = Unresolved ORDER BY updated DESC'
}

async function searchIssuesForClient(
  entry: JiraClientForSite,
  jql: string,
  limit: number
): Promise<JiraIssue[]> {
  // Server/DC only has the classic /search resource; /search/jql is Cloud-only.
  const searchPath =
    entry.site.authType === 'server'
      ? `${apiBasePath(entry.site)}/search`
      : '/rest/api/3/search/jql'
  const result = await jiraRequest<JiraSearchResponse>(entry, searchPath, {
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: limit,
      fields: ISSUE_FIELDS
    })
  })
  return (result.issues ?? []).slice(0, limit).map((issue) => mapJiraIssue(entry.site, issue))
}

export async function listIssues(
  filter: JiraIssueFilter = 'assigned',
  limit = 30,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  return searchIssues(filterToJql(filter), limit, siteId)
}

export async function searchIssues(
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  const entries = getClients(siteId)
  if (entries.length === 0 || !jql.trim()) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const fanout = await runBoundedIntegrationFanout(
    entries,
    async (entry, index) => {
      await acquire()
      try {
        return await searchIssuesForClient(entry, jql.trim(), safeLimit)
      } catch (error) {
        const authFailure = isAuthError(error)
        if (authFailure) {
          clearToken(entry.site.id)
        }
        if (surfaceSiteFailure) {
          throw toIssueSearchFailureError(error)
        }
        console.warn('[jira] searchIssues failed:', boundedIntegrationErrorLog(error))
        failures[index] = { error: toIssueSearchFailureError(error), auth: authFailure }
        return [] as JiraIssue[]
      } finally {
        release()
      }
    },
    (issues) => issues
  )
  // 'all' fan-out: only surface an error when every connected site failed, so a
  // partial success (or a genuinely empty result) is not reported as an error.
  const recordedFailures = failures.filter(
    (failure): failure is JiraIssueSearchFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  if (fanout.truncated) {
    console.warn('[jira] Cross-site search exceeded its aggregate result budget; truncating.')
  }
  const results = fanout.results.flat()
  return entries.length === 1 ? results.slice(0, safeLimit) : sortAndLimitIssues(results, safeLimit)
}

export async function getIssue(
  key: string,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue | null> {
  const entries = getClients(siteId)
  for (const entry of entries) {
    await acquire()
    try {
      const issue = await jiraRequest<JiraRecord>(
        entry,
        `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(
          ISSUE_FIELDS.join(',')
        )}`
      )
      return mapJiraIssue(entry.site, issue)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        if (shouldSurfaceSiteFailure(siteId, entries.length)) {
          throw error
        }
      } else {
        console.warn('[jira] getIssue failed:', boundedIntegrationErrorLog(error))
      }
    } finally {
      release()
    }
  }
  return null
}

export async function createIssue(args: JiraCreateIssueArgs): Promise<JiraCreateIssueResult> {
  const entry = getClients(args.siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }

  await acquire()
  try {
    const fields: JiraRecord = {
      project: { id: args.projectId },
      issuetype: { id: args.issueTypeId },
      summary: title
    }
    if (args.description?.trim()) {
      fields.description = toBodyText(entry.site, args.description.trim())
    }
    for (const [fieldKey, value] of Object.entries(args.customFields ?? {})) {
      if (!fieldKey || value === undefined || value === null || value === '') {
        continue
      }
      fields[fieldKey] = value
    }
    const created = await jiraRequest<{ id: string; key: string; self: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue`,
      {
        method: 'POST',
        body: JSON.stringify({ fields })
      }
    )
    return { ok: true, id: created.id, key: created.key, url: issueUrl(entry.site, created.key) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create issue.' }
  } finally {
    release()
  }
}

export async function updateIssue(
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const fields: JiraRecord = {}
    if (updates.title !== undefined) {
      fields.summary = updates.title
    }
    if (updates.labels !== undefined) {
      fields.labels = updates.labels
    }
    if (updates.priorityId !== undefined) {
      fields.priority = updates.priorityId ? { id: updates.priorityId } : null
    }
    const issueBase = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}`
    if (Object.keys(fields).length > 0) {
      await jiraRequest(entry, issueBase, {
        method: 'PUT',
        body: JSON.stringify({ fields })
      })
    }
    if (updates.assigneeAccountId !== undefined) {
      // Server/DC identifies assignees by username (`name`), not accountId;
      // mapUser stores the Server username in the accountId slot.
      const assigneeBody =
        entry.site.authType === 'server'
          ? { name: updates.assigneeAccountId }
          : { accountId: updates.assigneeAccountId }
      await jiraRequest(entry, `${issueBase}/assignee`, {
        method: 'PUT',
        body: JSON.stringify(assigneeBody)
      })
    }
    if (updates.transitionId) {
      await jiraRequest(entry, `${issueBase}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: updates.transitionId } })
      })
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update issue.' }
  } finally {
    release()
  }
}

export async function addIssueComment(
  key: string,
  body: string,
  siteId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const comment = await jiraRequest<{ id: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ body: toBodyText(entry.site, body) })
      }
    )
    return { ok: true, id: comment.id }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}

function mapComment(raw: JiraRecord): JiraComment {
  return {
    id: asString(raw.id),
    body: adfToMarkdownText(raw.body),
    createdAt: asString(raw.created, new Date().toISOString()),
    updatedAt: asString(raw.updated) || undefined,
    user: mapUser(raw.author)
  }
}

export async function getIssueComments(
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const comments = await fetchPagedRecords(entry, 'comments', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        orderBy: 'created',
        startAt: String(startAt)
      })
      return `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment?${params.toString()}`
    })
    return comments.map(mapComment)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getIssueComments failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function listProjects(siteId?: JiraSiteSelection | null): Promise<JiraProject[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const fanout = await runBoundedIntegrationFanout(
    entries,
    async (entry) => {
      await acquire()
      try {
        // Server/DC has no /project/search resource; /project returns the
        // full list as a plain (unpaged) array.
        const projects =
          entry.site.authType === 'server'
            ? await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/project`)
            : await fetchPagedRecords(entry, 'values', (startAt, maxResults) => {
                const params = new URLSearchParams({
                  maxResults: String(maxResults),
                  startAt: String(startAt)
                })
                return `/rest/api/3/project/search?${params.toString()}`
              })
        const retainedProjects = projects.slice(0, INTEGRATION_PAGINATION_MAX_ITEMS)
        if (projects.length > retainedProjects.length) {
          console.warn('[jira] Projects returned more rows than supported; truncating.')
        }
        return retainedProjects.map((project) => mapProject(project, entry.site))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[jira] listProjects failed:', boundedIntegrationErrorLog(error))
        }
        return []
      } finally {
        release()
      }
    },
    (projects) => projects
  )
  if (fanout.truncated) {
    console.warn('[jira] Cross-site projects exceeded their aggregate result budget; truncating.')
  }
  return fanout.results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listIssueTypes(
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const issueTypes = await fetchPagedRecords(entry, 'issueTypes', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      // Per-project createmeta paths exist on Server/DC from Jira 8.4 onward.
      return `${apiBasePath(entry.site)}/issue/createmeta/${encodeURIComponent(
        projectIdOrKey
      )}/issuetypes?${params.toString()}`
    })
    return issueTypes.map(mapIssueType)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listIssueTypes failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function listCreateFields(
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string | null
): Promise<JiraCreateField[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const fields: JiraCreateField[] = []
    const budget = new IntegrationPaginationBudget()
    let startAt = 0
    const maxResults = 100
    for (let guard = 0; guard < INTEGRATION_PAGINATION_MAX_PAGES; guard += 1) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
        entry,
        `${apiBasePath(entry.site)}/issue/createmeta/${encodeURIComponent(
          projectIdOrKey
        )}/issuetypes/${encodeURIComponent(issueTypeId)}?${params.toString()}`
      )
      const records = getCreateFieldRecords(response)
      if (!budget.admitPage(records)) {
        console.warn('[jira] Create fields exceeded their retained result budget; truncating.')
        break
      }
      for (const record of records) {
        const field = mapCreateField(record)
        if (field) {
          fields.push(field)
        }
      }
      if (!shouldFetchNextPage(response, startAt, records, maxResults)) {
        break
      }
      if (!budget.canRequestPage) {
        console.warn('[jira] Create fields reached their retained result budget; truncating.')
        break
      }
      startAt += asFiniteNumber(response.maxResults) ?? maxResults
    }
    return fields
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listCreateFields failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function listPriorities(siteId?: string | null): Promise<JiraPriority[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const response = await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/priority`)
    return response
      .slice(0, INTEGRATION_PAGINATION_MAX_ITEMS)
      .map(mapPriority)
      .filter((priority): priority is JiraPriority => !!priority)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listPriorities failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  key: string,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  const isServer = entry.site.authType === 'server'
  const params = new URLSearchParams({ issueKey: key, maxResults: '50' })
  if (query?.trim()) {
    // Server/DC filters assignable users by `username`; `query` is Cloud-only.
    params.set(isServer ? 'username' : 'query', query.trim())
  }
  await acquire()
  try {
    const response = await jiraRequest<JiraRecord[]>(
      entry,
      `${apiBasePath(entry.site)}/user/assignable/search?${params.toString()}`
    )
    return response
      .slice(0, 50)
      .map(mapUser)
      .filter((user): user is JiraUser => !!user)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listAssignableUsers failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function listTransitions(
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const response = await jiraRequest<{ transitions?: JiraRecord[] }>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/transitions`
    )
    return (response.transitions ?? [])
      .slice(0, INTEGRATION_PAGINATION_MAX_ITEMS)
      .map((transition) => ({
        id: asString(transition.id),
        name: asString(transition.name),
        to: mapStatus(transition.to)
      }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listTransitions failed:', boundedIntegrationErrorLog(error))
    return []
  } finally {
    release()
  }
}

export async function getProjectStatusOrder(
  projectKey: string,
  siteId?: string | null
): Promise<JiraProjectStatusOrder> {
  // Why: an omitted site can resolve to the persisted "all" selection; board
  // metadata is only truthful when exactly one Jira connection owns the project.
  const entries = getClients(siteId)
  const entry = entries.length === 1 ? entries[0] : undefined
  if (!entry) {
    return { statusIdsByColumn: [] }
  }
  await acquire()
  try {
    // Why: without an explicit board picker there is no truthful way to choose
    // among multiple project boards, so ambiguous projects keep alphabetical order.
    const params = new URLSearchParams({ projectKeyOrId: projectKey, maxResults: '2' })
    const boardsResponse = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      `/rest/agile/1.0/board?${params.toString()}`
    )
    const boards = boardsResponse.values ?? []
    const boardCount = asFiniteNumber(boardsResponse.total)
    const singleBoardIsProven =
      boards.length === 1 &&
      boardsResponse.isLast !== false &&
      (boardCount === 1 || (boardCount === null && boardsResponse.isLast === true))
    const boardId = singleBoardIsProven ? asIdentifier(asRecord(boards[0]).id) : ''
    if (!boardId) {
      return { statusIdsByColumn: [] }
    }

    const configResponse = await jiraRequest<unknown>(
      entry,
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`
    )
    const columns = asRecord(asRecord(configResponse).columnConfig).columns
    if (!Array.isArray(columns)) {
      return { statusIdsByColumn: [] }
    }

    // Why: issues already carry status names and IDs, so returning board IDs
    // avoids a second metadata request and keeps duplicate names unambiguous.
    const seenStatusIds = new Set<string>()
    const statusIdsByColumn: string[][] = []
    for (const column of columns) {
      if (seenStatusIds.size >= INTEGRATION_PAGINATION_MAX_ITEMS) {
        break
      }
      const statuses = asRecord(column).statuses
      if (!Array.isArray(statuses)) {
        continue
      }
      const columnStatusIds: string[] = []
      for (const status of statuses) {
        if (seenStatusIds.size >= INTEGRATION_PAGINATION_MAX_ITEMS) {
          break
        }
        const statusId = asIdentifier(asRecord(status).id)
        if (statusId && !seenStatusIds.has(statusId)) {
          seenStatusIds.add(statusId)
          columnStatusIds.push(statusId)
        }
      }
      if (columnStatusIds.length > 0) {
        statusIdsByColumn.push(columnStatusIds)
      }
    }
    return { statusIdsByColumn }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getProjectStatusOrder failed:', boundedIntegrationErrorLog(error))
    return { statusIdsByColumn: [] }
  } finally {
    release()
  }
}
