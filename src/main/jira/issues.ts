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
  apiBasePath,
  clearToken,
  getClients,
  isAuthError,
  jiraRequest,
  release,
  type JiraClientForSite
} from './client'
import {
  adfToMarkdownText,
  collectAdfMediaAttrs,
  textToAdf,
  type AdfToMarkdownOptions,
  type JiraAdfMediaAttrs
} from './adf-markdown'
import {
  extractAttachmentContentIdsFromHtml,
  selectPreferredAttachmentIds,
  warnIfMediaResolutionIncomplete
} from './attachment-discovery'
import {
  createMediaMarkdownResolver,
  loadIssueImageAttachments,
  type MediaResolutionStats
} from './attachment-images'
import { JiraSummaryLookupError } from '../../shared/jira-summary-lookup'

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

// Why: list/typeahead only need identity + metadata; description ADF parse is the hot-path cost.
const ISSUE_LIST_FIELDS = ISSUE_FIELDS.filter((field) => field !== 'description')

// Why: detail reads need attachment metadata so inline ADF media can be resolved
// to downloadable image content; list/search omit this for payload size.
const ISSUE_DETAIL_FIELDS = [...ISSUE_FIELDS, 'attachment']
// `created`/`updated` are required: mapJiraIssue falls back to "now" when they're absent,
// which would silently report the lookup time as the issue's timestamps.
const ISSUE_SUMMARY_FIELDS = ['summary', 'project', 'issuetype', 'status', 'created', 'updated']
const ISSUE_SUMMARY_TIMEOUT_MS = 30_000
const ISSUE_SEARCH_TIMEOUT_MS = 30_000

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

/** Run against one signal that trips on the caller's abort or the request deadline. */
async function withJiraDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (deadlineSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function settleJiraSummaryRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Jira summary lookup aborted'))
  }
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      cleanup()
      reject(new Error('Jira summary lookup aborted'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', handleAbort)
    signal.addEventListener('abort', handleAbort, { once: true })
    void read.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
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

export function mapJiraIssue(
  site: JiraSite,
  raw: JiraRecord,
  adfOptions?: AdfToMarkdownOptions
): JiraIssue {
  const fields = asRecord(raw.fields)
  const key = asString(raw.key)
  return {
    id: asString(raw.id, key),
    key,
    siteId: site.id,
    siteName: site.displayName,
    title: asString(fields.summary, key || 'Untitled issue'),
    description: adfToMarkdownText(fields.description, adfOptions),
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

type MediaRequest = {
  attachmentField: unknown
  preferredIds: string[]
  needCount: number
  fallbackRan: boolean
  issueKey: string
}

/** Pooled: HTML/ADF selection only — no binary downloads. */
function collectIssueMediaRequest(raw: JiraRecord): MediaRequest | undefined {
  const fields = asRecord(raw.fields)
  const renderedFields = asRecord(raw.renderedFields)
  const htmlIds = extractAttachmentContentIdsFromHtml(
    asString(renderedFields.description) || undefined
  )
  const mediaAttrs = collectAdfMediaAttrs(fields.description)
  const selection = selectPreferredAttachmentIds({
    renderedHtmlIds: htmlIds,
    attachmentField: fields.attachment,
    mediaAttrs
  })
  if (selection.needCount === 0 && selection.preferredIds.length === 0) {
    return undefined
  }
  return {
    attachmentField: fields.attachment,
    preferredIds: selection.preferredIds,
    needCount: selection.needCount,
    fallbackRan: selection.fallbackRan,
    issueKey: asString(raw.key)
  }
}

type PreparedMedia = {
  options: AdfToMarkdownOptions
  stats: MediaResolutionStats
  request: MediaRequest
}

/** Unpooled: binary downloads + resolver (outside the Jira API semaphore). */
async function prepareMediaResolver(
  client: JiraClientForSite,
  request: MediaRequest
): Promise<PreparedMedia | undefined> {
  if (request.preferredIds.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: 0,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const images = await loadIssueImageAttachments(
    client,
    request.attachmentField,
    request.preferredIds
  )
  if (images.length === 0) {
    warnIfMediaResolutionIncomplete({
      siteId: client.site.id,
      issueKey: request.issueKey,
      needCount: request.needCount,
      preferredIdCount: request.preferredIds.length,
      resolvedCount: 0,
      fallbackRan: request.fallbackRan
    })
    return undefined
  }
  const stats: MediaResolutionStats = { attachmentResolvedCount: 0 }
  const resolveMedia = createMediaMarkdownResolver(images, request.preferredIds, stats)
  return {
    options: { resolveMedia },
    stats,
    request
  }
}

function flushMediaResolutionWarn(client: JiraClientForSite, prepared: PreparedMedia): void {
  warnIfMediaResolutionIncomplete({
    siteId: client.site.id,
    issueKey: prepared.request.issueKey,
    needCount: prepared.request.needCount,
    preferredIdCount: prepared.request.preferredIds.length,
    resolvedCount: prepared.stats.attachmentResolvedCount,
    fallbackRan: prepared.request.fallbackRan
  })
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
  limit: number,
  signal?: AbortSignal
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
      fields: ISSUE_LIST_FIELDS
    }),
    signal
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
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal
): Promise<JiraIssue[]> {
  const entries = getClients(siteId)
  if (entries.length === 0 || !jql.trim()) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (JiraIssueSearchFailure | undefined)[] = Array.from({ length: entries.length })
  const surfaceSiteFailure = shouldSurfaceSiteFailure(siteId, entries.length)
  const results = await withJiraDeadline(signal, ISSUE_SEARCH_TIMEOUT_MS, (requestSignal) =>
    Promise.all(
      entries.map(async (entry, index) => {
        // Why: queueing on an abandoned search would keep occupying the shared Jira pool.
        await acquire(requestSignal)
        try {
          return await searchIssuesForClient(entry, jql.trim(), safeLimit, requestSignal)
        } catch (error) {
          if (requestSignal.aborted) {
            // Abandoned by the caller: not a site failure, so don't clear tokens or mask a real one.
            throw error
          }
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
    let mediaRequest: MediaRequest | undefined
    let issue: JiraRecord | undefined
    let held = false
    try {
      await acquire()
      held = true
      const params = new URLSearchParams({
        fields: ISSUE_DETAIL_FIELDS.join(','),
        expand: 'renderedFields'
      })
      issue = await jiraRequest<JiraRecord>(
        entry,
        `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?${params.toString()}`
      )
      // Why: keep only JSON under the pool; binary downloads fan out after release.
      mediaRequest = collectIssueMediaRequest(issue)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        if (shouldSurfaceSiteFailure(siteId, entries.length)) {
          throw error
        }
      } else {
        console.warn('[jira] getIssue failed:', error)
      }
      continue
    } finally {
      if (held) {
        held = false
        release()
      }
    }

    try {
      if (!issue) {
        continue
      }
      const prepared = mediaRequest ? await prepareMediaResolver(entry, mediaRequest) : undefined
      const mapped = mapJiraIssue(entry.site, issue, prepared?.options)
      if (prepared) {
        flushMediaResolutionWarn(entry, prepared)
      }
      return mapped
    } catch (error) {
      console.warn('[jira] getIssue media load failed:', error)
      return mapJiraIssue(entry.site, issue)
    }
  }
  return null
}

export async function getIssueSummary(
  key: string,
  siteId: string,
  signal?: AbortSignal
): Promise<JiraIssue | null> {
  let entries: JiraClientForSite[]
  try {
    entries = getClients(siteId)
  } catch (error) {
    throw new JiraSummaryLookupError('auth', error)
  }
  const entry = entries.find((candidate) => candidate.site.id === siteId)
  if (!entry) {
    throw new JiraSummaryLookupError('disconnected')
  }

  return withJiraDeadline(signal, ISSUE_SUMMARY_TIMEOUT_MS, async (requestSignal) => {
    await acquire(requestSignal)
    try {
      const params = new URLSearchParams({ fields: ISSUE_SUMMARY_FIELDS.join(',') })
      const issue = await settleJiraSummaryRead(
        jiraRequest<JiraRecord>(
          entry,
          `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?${params.toString()}`,
          { signal: requestSignal }
        ),
        requestSignal
      )
      return mapJiraIssue(entry.site, issue)
    } catch (error) {
      if (isAuthError(error)) {
        throw new JiraSummaryLookupError('auth', error)
      }
      if (getErrorStatus(error) === 404) {
        throw new JiraSummaryLookupError('not-found', error)
      }
      throw new JiraSummaryLookupError('read-failed', error)
    } finally {
      release()
    }
  })
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

function mapComment(raw: JiraRecord, adfOptions?: AdfToMarkdownOptions): JiraComment {
  return {
    id: asString(raw.id),
    body: adfToMarkdownText(raw.body, adfOptions),
    createdAt: asString(raw.created, new Date().toISOString()),
    updatedAt: asString(raw.updated) || undefined,
    user: mapUser(raw.author)
  }
}

/**
 * Pooled comment media collect: attachment metadata JSON stays under the semaphore.
 * Residual: Server/DC comment bodies are wiki markup, not ADF — this only fixes
 * the lookup path; wiki `!filename!` is not rendered as media.
 */
async function collectCommentMediaRequest(
  client: JiraClientForSite,
  key: string,
  comments: JiraRecord[]
): Promise<MediaRequest | undefined> {
  const htmlIds: string[] = []
  const seen = new Set<string>()
  const mediaAttrs: JiraAdfMediaAttrs[] = []
  for (const comment of comments) {
    for (const id of extractAttachmentContentIdsFromHtml(asString(comment.renderedBody))) {
      if (!seen.has(id)) {
        seen.add(id)
        htmlIds.push(id)
      }
    }
    mediaAttrs.push(...collectAdfMediaAttrs(comment.body))
  }

  const needingCount = mediaAttrs.filter(
    (attrs) => !(attrs.url && /^https?:\/\//i.test(attrs.url))
  ).length
  // Why: selectPreferredAttachmentIds yields nothing without attachment-needing media, so
  // HTML ids alone can never produce a download — skip the extra metadata request entirely.
  if (needingCount === 0) {
    return undefined
  }

  // Why: comment media usually references issue-level attachments; pull them once
  // for the whole thread. Use apiBasePath so Server/DC does not 404 on /rest/api/3.
  let attachmentField: unknown
  try {
    const issue = await jiraRequest<JiraRecord>(
      client,
      `${apiBasePath(client.site)}/issue/${encodeURIComponent(key)}?fields=attachment`
    )
    attachmentField = asRecord(issue.fields).attachment
  } catch (error) {
    console.warn('[jira] comment attachment lookup failed:', error)
    return undefined
  }

  const selection = selectPreferredAttachmentIds({
    renderedHtmlIds: htmlIds,
    attachmentField,
    mediaAttrs
  })
  if (selection.needCount === 0 && selection.preferredIds.length === 0) {
    return undefined
  }
  return {
    attachmentField,
    preferredIds: selection.preferredIds,
    needCount: selection.needCount,
    fallbackRan: selection.fallbackRan,
    issueKey: key
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

  let comments: JiraRecord[] = []
  let mediaRequest: MediaRequest | undefined
  let held = false
  try {
    await acquire()
    held = true
    comments = await fetchPagedRecords(entry, 'comments', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        orderBy: 'created',
        startAt: String(startAt),
        expand: 'renderedBody'
      })
      return `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment?${params.toString()}`
    })
    mediaRequest = await collectCommentMediaRequest(entry, key, comments)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getIssueComments failed:', error)
    return []
  } finally {
    if (held) {
      held = false
      release()
    }
  }

  try {
    const prepared = mediaRequest ? await prepareMediaResolver(entry, mediaRequest) : undefined
    const mapped = comments.map((comment) => mapComment(comment, prepared?.options))
    if (prepared) {
      flushMediaResolutionWarn(entry, prepared)
    }
    return mapped
  } catch (error) {
    console.warn('[jira] getIssueComments media load failed:', error)
    return comments.map((comment) => mapComment(comment))
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
        `${apiBasePath(entry.site)}/issue/createmeta/${encodeURIComponent(
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
    const response = await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/priority`)
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
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/transitions`
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
