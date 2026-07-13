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
  acquire,
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

function toIssueSearchFailureError(error: unknown): unknown {
  const status = getErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
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
  let startAt = 0
  for (let guard = 0; guard < 100; guard += 1) {
    const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      pathForPage(startAt, maxResults)
    )
    const items = getPageItems(response, key)
    records.push(...items)
    if (!shouldFetchNextPage(response, startAt, items, maxResults)) {
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
  const accountId = asString(user.accountId)
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
  const result = await jiraRequest<JiraSearchResponse>(entry, '/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: limit,
      fields: ISSUE_FIELDS
    })
  })
  return (result.issues ?? []).map((issue) => mapJiraIssue(entry.site, issue))
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
  const results = await Promise.all(
    entries.map(async (entry, index) => {
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
        console.warn('[jira] searchIssues failed:', error)
        failures[index] = { error: toIssueSearchFailureError(error), auth: authFailure }
        return [] as JiraIssue[]
      } finally {
        release()
      }
    })
  )
  // 'all' fan-out: only surface an error when every connected site failed, so a
  // partial success (or a genuinely empty result) is not reported as an error.
  const recordedFailures = failures.filter(
    (failure): failure is JiraIssueSearchFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return entries.length === 1
    ? results.flat().slice(0, safeLimit)
    : sortAndLimitIssues(results.flat(), safeLimit)
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
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(
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
        console.warn('[jira] getIssue failed:', error)
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
      fields.description = textToAdf(args.description.trim())
    }
    for (const [fieldKey, value] of Object.entries(args.customFields ?? {})) {
      if (!fieldKey || value === undefined || value === null || value === '') {
        continue
      }
      fields[fieldKey] = value
    }
    const created = await jiraRequest<{ id: string; key: string; self: string }>(
      entry,
      '/rest/api/3/issue',
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
    if (Object.keys(fields).length > 0) {
      await jiraRequest(entry, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ fields })
      })
    }
    if (updates.assigneeAccountId !== undefined) {
      await jiraRequest(entry, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
        method: 'PUT',
        body: JSON.stringify({ accountId: updates.assigneeAccountId })
      })
    }
    if (updates.transitionId) {
      await jiraRequest(entry, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
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
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ body: textToAdf(body) })
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
      return `/rest/api/3/issue/${encodeURIComponent(key)}/comment?${params.toString()}`
    })
    return comments.map(mapComment)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getIssueComments failed:', error)
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
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const projects = await fetchPagedRecords(entry, 'values', (startAt, maxResults) => {
          const params = new URLSearchParams({
            maxResults: String(maxResults),
            startAt: String(startAt)
          })
          return `/rest/api/3/project/search?${params.toString()}`
        })
        return projects.map((project) => mapProject(project, entry.site))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
          if (shouldSurfaceSiteFailure(siteId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[jira] listProjects failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
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
      return `/rest/api/3/issue/createmeta/${encodeURIComponent(
        projectIdOrKey
      )}/issuetypes?${params.toString()}`
    })
    return issueTypes.map(mapIssueType)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listIssueTypes failed:', error)
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
    let startAt = 0
    const maxResults = 100
    for (let guard = 0; guard < 100; guard += 1) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
        entry,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(
          projectIdOrKey
        )}/issuetypes/${encodeURIComponent(issueTypeId)}?${params.toString()}`
      )
      const records = getCreateFieldRecords(response)
      fields.push(
        ...records
          .map((record) => mapCreateField(record))
          .filter((field): field is JiraCreateField => field !== null)
      )
      if (!shouldFetchNextPage(response, startAt, records, maxResults)) {
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
    console.warn('[jira] listCreateFields failed:', error)
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
    const response = await jiraRequest<JiraRecord[]>(entry, '/rest/api/3/priority')
    return response.map(mapPriority).filter((priority): priority is JiraPriority => !!priority)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listPriorities failed:', error)
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
  const params = new URLSearchParams({ issueKey: key, maxResults: '50' })
  if (query?.trim()) {
    params.set('query', query.trim())
  }
  await acquire()
  try {
    const response = await jiraRequest<JiraRecord[]>(
      entry,
      `/rest/api/3/user/assignable/search?${params.toString()}`
    )
    return response.map(mapUser).filter((user): user is JiraUser => !!user)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listAssignableUsers failed:', error)
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
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
    )
    return (response.transitions ?? []).map((transition) => ({
      id: asString(transition.id),
      name: asString(transition.name),
      to: mapStatus(transition.to)
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listTransitions failed:', error)
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
      const statuses = asRecord(column).statuses
      if (!Array.isArray(statuses)) {
        continue
      }
      const columnStatusIds: string[] = []
      for (const status of statuses) {
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
    console.warn('[jira] getProjectStatusOrder failed:', error)
    return { statusIdsByColumn: [] }
  } finally {
    release()
  }
}
