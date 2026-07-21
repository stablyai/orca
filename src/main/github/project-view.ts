/* eslint-disable max-lines -- Why: co-locate the ProjectV2 read path (normalize/retry/paste-parser/discovery) as one reviewable surface; plumbing lives in ./project-view/internals and mutations. */
import {
  acquire,
  release,
  extractExecError,
  ghExecFileAsync,
  repositoryRateLimitGuard,
  noteRepositoryRateLimitSpend,
  runGraphql,
  isValidOwnerSlug,
  assertSlug,
  assertPositiveInt,
  projectHostAuthenticationError,
  projectGhExecOptions,
  type GraphqlVars
} from './project-view/internals'
import {
  classifyProjectError,
  driftError,
  errorsIndicateParentField,
  rateLimitedError,
  type GhGraphqlErrorShape
} from './project-view/project-error-classification'
import type {
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectIteration,
  GitHubProjectLabel,
  GitHubProjectOwnerType,
  GitHubProjectRow,
  GitHubProjectRowItemType,
  GitHubProjectSingleSelectOption,
  GitHubProjectSort,
  GitHubProjectSummary,
  GitHubProjectTable,
  GitHubProjectUser,
  GitHubProjectView,
  GitHubProjectViewError,
  GitHubProjectViewLayout,
  GitHubProjectViewSummary,
  ListAccessibleProjectsArgs,
  ListAccessibleProjectsResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult
} from '../../shared/github-project-types'
import {
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
  isGitHubProjectRefInputTooLarge
} from '../../shared/github-project-ref-input'
import { githubProjectHost } from '../../shared/github-project-identity'

// Re-export the public API so existing `./project-view` call sites keep working; the split is internal-only.
export { isValidOwnerSlug, isValidRepoSlug, isValidSlug } from './project-view/internals'
export { classifyProjectError } from './project-view/project-error-classification'
export {
  updateProjectItemFieldValue,
  clearProjectItemFieldValue,
  updateIssueBySlug,
  updatePullRequestBySlug,
  addIssueCommentBySlug,
  updateIssueCommentBySlug,
  deleteIssueCommentBySlug,
  listLabelsBySlug,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  updateIssueTypeBySlug,
  getWorkItemDetailsBySlug
} from './project-view/mutations'

// ─── Constants ─────────────────────────────────────────────────────────

// Why: defaults deliberately shrunk to cut quota spend in discovery — the org loop dominates and produced the HTTP 504; overflow owners can paste a URL.
const ITEM_PAGE_SIZE = 100
const MAX_ITEMS = 500
const VIEWS_PAGE_SIZE = 20
const FIELDS_PAGE_SIZE = 50
const DISCOVERY_PROJECTS_PER_OWNER = 40
const DISCOVERY_MAX_ORGS = 20
const DISCOVERY_ORG_PAGE_SIZE = 20
const DISCOVERY_PROJECTS_PER_ORG = 20
const FIELD_VALUES_PAGE_SIZE = 100
export const PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES = 512

// ─── Module-scope caches (reset on HMR — intentional) ──────────────────

// Why: owners are user-controlled over a long session; bound cache entries to avoid unbounded retention while keeping the hot-owner fast path.
function rememberProjectViewCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES
): void {
  if (cache.has(key)) {
    cache.delete(key)
  }
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done) {
      break
    }
    cache.delete(oldest.value)
  }
}

function getProjectViewCacheEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) {
    return undefined
  }
  const value = cache.get(key) as V
  rememberProjectViewCacheEntry(cache, key, value)
  return value
}

// Why: plain module locals so HMR code swaps re-run capability probes instead of carrying a stale "unsupported" flag.
const ownerTypeCache = new Map<string, GitHubProjectOwnerType | null>()
// Why: keyed per owner (not a process-global flag) so one owner's capability gap doesn't poison others that DO support Issue.parent (bug-scan finding 2).
const parentFieldRetriedByOwner = new Map<string, true>()
const parentFieldWarningLoggedByOwner = new Map<string, true>()
// Why: in-flight promise per owner so concurrent fetchAllItems callers share one probe instead of each racing a duplicate first-page probe.
const parentFieldProbeInFlight = new Map<string, Promise<void>>()

// Why: GHES owners are a separate namespace and capability surface from
// github.com owners with the same login — scope cache keys by host so one
// host's probe result can't leak into another. Normalize github.com so
// host-less callers share the same probe state as explicitly pinned calls.
function ownerScopeKey(owner: string, ownerType: GitHubProjectOwnerType, host?: string): string {
  const base = `${owner}\u0000${ownerType}`
  return `${base}\u0000${githubProjectHost(host)}`
}

function ownerTypeCacheKey(owner: string, host?: string): string {
  return `${owner}\u0000${githubProjectHost(host)}`
}

function rememberOwnerType(
  owner: string,
  ownerType: GitHubProjectOwnerType | null,
  host?: string
): void {
  rememberProjectViewCacheEntry(ownerTypeCache, ownerTypeCacheKey(owner, host), ownerType)
}

function getCachedOwnerType(
  owner: string,
  host?: string
): GitHubProjectOwnerType | null | undefined {
  return getProjectViewCacheEntry(ownerTypeCache, ownerTypeCacheKey(owner, host))
}

function markParentFieldRetried(scopeKey: string): void {
  rememberProjectViewCacheEntry(parentFieldRetriedByOwner, scopeKey, true)
}

function hasParentFieldRetried(scopeKey: string): boolean {
  return getProjectViewCacheEntry(parentFieldRetriedByOwner, scopeKey) === true
}

function markParentFieldWarningLogged(scopeKey: string): void {
  rememberProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey, true)
}

function hasParentFieldWarningLogged(scopeKey: string): boolean {
  return getProjectViewCacheEntry(parentFieldWarningLoggedByOwner, scopeKey) === true
}

export function _resetProjectViewCachesForTests(): void {
  ownerTypeCache.clear()
  parentFieldRetriedByOwner.clear()
  parentFieldWarningLoggedByOwner.clear()
  parentFieldProbeInFlight.clear()
}

export function _getProjectViewCacheSizesForTests(): {
  ownerTypes: number
  parentFieldRetries: number
  parentFieldWarnings: number
  parentFieldProbes: number
} {
  return {
    ownerTypes: ownerTypeCache.size,
    parentFieldRetries: parentFieldRetriedByOwner.size,
    parentFieldWarnings: parentFieldWarningLoggedByOwner.size,
    parentFieldProbes: parentFieldProbeInFlight.size
  }
}

/** @internal - exposed for cache-bound tests only. */
export function _rememberProjectViewOwnerTypeForTests(
  owner: string,
  ownerType: GitHubProjectOwnerType | null,
  host?: string
): void {
  rememberOwnerType(owner, ownerType, host)
}

/** @internal - exposed for cache-bound tests only. */
export function _getProjectViewOwnerTypeForTests(
  owner: string,
  host?: string
): GitHubProjectOwnerType | null | undefined {
  return getCachedOwnerType(owner, host)
}

/** @internal - exposed for cache-bound tests only. */
export function _markProjectViewParentFieldRetriedForTests(scopeKey: string): void {
  markParentFieldRetried(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldRetriedForTests(scopeKey: string): boolean {
  return hasParentFieldRetried(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _markProjectViewParentFieldWarningLoggedForTests(scopeKey: string): void {
  markParentFieldWarningLogged(scopeKey)
}

/** @internal - exposed for cache-bound tests only. */
export function _hasProjectViewParentFieldWarningLoggedForTests(scopeKey: string): boolean {
  return hasParentFieldWarningLogged(scopeKey)
}

// ─── Normalizers ───────────────────────────────────────────────────────

type RawProjectV2Field = {
  __typename?: string
  id?: string
  name?: string
  dataType?: string
  options?: { id?: string; name?: string; color?: string }[]
  configuration?: {
    iterations?: { id?: string; title?: string; startDate?: string; duration?: number }[]
    completedIterations?: {
      id?: string
      title?: string
      startDate?: string
      duration?: number
    }[]
  }
}

export function normalizeField(
  raw: RawProjectV2Field | null | undefined
): GitHubProjectField | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null
  }
  const dataType = raw.dataType ?? raw.__typename ?? ''
  if (raw.__typename === 'ProjectV2SingleSelectField' || dataType === 'SINGLE_SELECT') {
    const options: GitHubProjectSingleSelectOption[] = (raw.options ?? [])
      .map((o) =>
        typeof o.id === 'string' && typeof o.name === 'string'
          ? { id: o.id, name: o.name, color: o.color ?? '' }
          : null
      )
      .filter((o): o is GitHubProjectSingleSelectOption => o !== null)
    return { kind: 'single-select', id: raw.id, name: raw.name, dataType: 'SINGLE_SELECT', options }
  }
  if (raw.__typename === 'ProjectV2IterationField' || dataType === 'ITERATION') {
    const cfg = raw.configuration ?? {}
    const iterations: GitHubProjectIteration[] = []
    for (const it of cfg.completedIterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: true
        })
      }
    }
    for (const it of cfg.iterations ?? []) {
      if (typeof it.id === 'string' && typeof it.title === 'string') {
        iterations.push({
          id: it.id,
          title: it.title,
          startDate: it.startDate ?? '',
          duration: typeof it.duration === 'number' ? it.duration : 0,
          completed: false
        })
      }
    }
    return { kind: 'iteration', id: raw.id, name: raw.name, dataType: 'ITERATION', iterations }
  }
  return { kind: 'field', id: raw.id, name: raw.name, dataType }
}

type RawUser = {
  login?: string
  name?: string | null
  avatarUrl?: string | null
}

function normalizeUser(raw: RawUser | null | undefined): GitHubProjectUser | null {
  if (!raw || typeof raw.login !== 'string') {
    return null
  }
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null
  }
}

type RawLabel = { name?: string; color?: string }

function normalizeLabel(raw: RawLabel | null | undefined): GitHubProjectLabel | null {
  if (!raw || typeof raw.name !== 'string') {
    return null
  }
  return { name: raw.name, color: raw.color ?? '' }
}

type RawFieldValue = {
  __typename?: string
  field?: RawProjectV2Field
  name?: string
  color?: string
  optionId?: string
  title?: string
  startDate?: string
  duration?: number
  iterationId?: string
  text?: string
  number?: number
  date?: string
  labels?: { nodes?: RawLabel[] }
  users?: { nodes?: RawUser[] }
}

export function normalizeFieldValue(
  raw: RawFieldValue | null | undefined
): GitHubProjectFieldValue | null {
  if (!raw || !raw.field || typeof raw.field.id !== 'string') {
    return null
  }
  const fieldId = raw.field.id
  switch (raw.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      if (typeof raw.optionId !== 'string') {
        return null
      }
      return {
        kind: 'single-select',
        fieldId,
        optionId: raw.optionId,
        name: raw.name ?? '',
        color: raw.color ?? ''
      }
    case 'ProjectV2ItemFieldIterationValue':
      if (typeof raw.iterationId !== 'string') {
        return null
      }
      return {
        kind: 'iteration',
        fieldId,
        iterationId: raw.iterationId,
        title: raw.title ?? '',
        startDate: raw.startDate ?? '',
        duration: typeof raw.duration === 'number' ? raw.duration : 0
      }
    case 'ProjectV2ItemFieldTextValue':
      return { kind: 'text', fieldId, text: raw.text ?? '' }
    case 'ProjectV2ItemFieldNumberValue':
      if (typeof raw.number !== 'number') {
        return null
      }
      return { kind: 'number', fieldId, number: raw.number }
    case 'ProjectV2ItemFieldDateValue':
      return { kind: 'date', fieldId, date: raw.date ?? '' }
    case 'ProjectV2ItemFieldLabelValue': {
      const labels = (raw.labels?.nodes ?? [])
        .map(normalizeLabel)
        .filter((l): l is GitHubProjectLabel => l !== null)
      return { kind: 'labels', fieldId, labels }
    }
    case 'ProjectV2ItemFieldUserValue': {
      const users = (raw.users?.nodes ?? [])
        .map(normalizeUser)
        .filter((u): u is GitHubProjectUser => u !== null)
      return { kind: 'users', fieldId, users }
    }
    case undefined:
    default:
      // Unknown __typename → forward-compat: drop silently, don't classify as drift (see design §Error Handling).
      return null
  }
}

type RawContent = {
  __typename?: string
  id?: string
  number?: number
  title?: string
  body?: string
  url?: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  repository?: { nameWithOwner?: string }
  assignees?: { nodes?: RawUser[] }
  labels?: { nodes?: RawLabel[] }
  parent?: { number?: number; title?: string; url?: string } | null
  issueType?: {
    id?: string
    name?: string
    color?: string | null
    description?: string | null
  } | null
}

type RawItem = {
  id?: string
  type?: string
  updatedAt?: string
  content?: RawContent | null
  fieldValues?: {
    nodes?: RawFieldValue[]
    pageInfo?: { hasNextPage?: boolean }
  }
}

type NormalizedItemOutcome =
  | { ok: true; row: GitHubProjectRow }
  | { ok: false; drift: GitHubProjectViewError }

function mapItemType(raw: string | undefined, hasContent: boolean): GitHubProjectRowItemType {
  if (raw === 'ISSUE') {
    return 'ISSUE'
  }
  if (raw === 'PULL_REQUEST') {
    return 'PULL_REQUEST'
  }
  if (raw === 'DRAFT_ISSUE') {
    return 'DRAFT_ISSUE'
  }
  if (raw === 'REDACTED' || !hasContent) {
    return 'REDACTED'
  }
  // Unknown item type with content — treat as redacted rather than dropping.
  return 'REDACTED'
}

export function normalizeItem(raw: RawItem, position: number): NormalizedItemOutcome {
  if (!raw || typeof raw.id !== 'string') {
    return {
      ok: false,
      drift: driftError('item missing id', { path: ['items', 'nodes', position, 'id'] })
    }
  }
  if (raw.fieldValues?.pageInfo?.hasNextPage === true) {
    return {
      ok: false,
      drift: driftError('item field values exceeded single page', {
        path: ['items', 'nodes', position, 'fieldValues', 'pageInfo', 'hasNextPage']
      })
    }
  }
  const itemType = mapItemType(raw.type, raw.content !== null && raw.content !== undefined)
  const content = raw.content ?? null
  const assignees = (content?.assignees?.nodes ?? [])
    .map(normalizeUser)
    .filter((u): u is GitHubProjectUser => u !== null)
  const labels = (content?.labels?.nodes ?? [])
    .map(normalizeLabel)
    .filter((l): l is GitHubProjectLabel => l !== null)
  const parentIssue =
    content?.parent &&
    typeof content.parent.number === 'number' &&
    typeof content.parent.title === 'string' &&
    typeof content.parent.url === 'string'
      ? { number: content.parent.number, title: content.parent.title, url: content.parent.url }
      : null
  const issueType =
    content?.issueType &&
    typeof content.issueType.id === 'string' &&
    typeof content.issueType.name === 'string'
      ? {
          id: content.issueType.id,
          name: content.issueType.name,
          color: typeof content.issueType.color === 'string' ? content.issueType.color : null,
          description:
            typeof content.issueType.description === 'string' ? content.issueType.description : null
        }
      : null
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const fv of raw.fieldValues?.nodes ?? []) {
    const normalized = normalizeFieldValue(fv)
    if (normalized) {
      fieldValuesByFieldId[normalized.fieldId] = normalized
    }
  }
  const title =
    itemType === 'REDACTED'
      ? 'Restricted item'
      : typeof content?.title === 'string'
        ? content.title
        : ''
  const row: GitHubProjectRow = {
    id: raw.id,
    itemType,
    content: {
      number: typeof content?.number === 'number' ? content.number : null,
      title,
      body: typeof content?.body === 'string' ? content.body : null,
      url: typeof content?.url === 'string' ? content.url : null,
      state: typeof content?.state === 'string' ? content.state : null,
      stateReason: typeof content?.stateReason === 'string' ? content.stateReason : null,
      isDraft: typeof content?.isDraft === 'boolean' ? content.isDraft : null,
      repository:
        typeof content?.repository?.nameWithOwner === 'string'
          ? content.repository.nameWithOwner
          : null,
      assignees,
      labels,
      parentIssue,
      issueType
    },
    fieldValuesByFieldId,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    position
  }
  return { ok: true, row }
}

// ─── GraphQL query fragments ───────────────────────────────────────────

const FIELD_CONFIG_FRAGMENT = `
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField {
    id
    name
    dataType
    options { id name color }
  }
  ... on ProjectV2IterationField {
    id
    name
    dataType
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
}
`

function itemContentSelection(includeParent: boolean): string {
  const parentFrag = includeParent ? 'parent { number title url }' : ''
  return `
    __typename
    ... on Issue {
      id
      number
      title
      url
      state
      stateReason
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
      issueType { id name color description }
      ${parentFrag}
    }
    ... on PullRequest {
      id
      number
      title
      url
      state
      isDraft
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
    }
    ... on DraftIssue { id title body }
  `
}

const FIELD_VALUES_SELECTION = `
  fieldValues(first:${FIELD_VALUES_PAGE_SIZE}) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { field { ...FieldConfig } name color optionId }
      ... on ProjectV2ItemFieldIterationValue    { field { ...FieldConfig } title startDate duration iterationId }
      ... on ProjectV2ItemFieldTextValue         { field { ...FieldConfig } text }
      ... on ProjectV2ItemFieldNumberValue       { field { ...FieldConfig } number }
      ... on ProjectV2ItemFieldDateValue         { field { ...FieldConfig } date }
      ... on ProjectV2ItemFieldLabelValue        { field { ...FieldConfig } labels(first:10) { nodes { name color } } }
      ... on ProjectV2ItemFieldUserValue         { field { ...FieldConfig } users(first:5) { nodes { login name avatarUrl } } }
    }
  }
`

// ─── Project config fetch (views + fields, paginated) ──────────────────

type RawProjectConfig = {
  id?: string
  title?: string
  url?: string
  views?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: (RawProjectView | null)[]
  }
}

type RawProjectView = {
  id?: string
  number?: number
  name?: string
  layout?: string
  filter?: string | null
  fields?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: (RawProjectV2Field | null)[]
  }
  groupByFields?: { nodes?: (RawProjectV2Field | null)[] }
  sortByFields?: {
    nodes?: ({ direction?: string; field?: RawProjectV2Field | null } | null)[]
  }
}

function ownerQueryRoot(ownerType: GitHubProjectOwnerType): string {
  return ownerType === 'organization' ? 'organization' : 'user'
}

async function fetchProjectViewsPage(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  host?: string
  after: string | null
}): Promise<
  | {
      ok: true
      project: { id: string; title: string; url: string }
      views: RawProjectView[]
      hasNextPage: boolean
      endCursor: string | null
    }
  | { ok: false; error: GitHubProjectViewError }
> {
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          id title url
          views(first:${VIEWS_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number name layout filter
              fields(first:${FIELDS_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes { ...FieldConfig }
              }
              groupByFields(first:10) { nodes { ...FieldConfig } }
              sortByFields(first:10) {
                nodes { direction field { ...FieldConfig } }
              }
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const vars: GraphqlVars = { owner: args.owner, num: args.projectNumber }
  if (args.after) {
    vars.after = args.after
  }
  const res = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
    query,
    vars,
    projectGhExecOptions(args.host)
  )
  if (!res.ok) {
    return res
  }
  const top = res.data[root]
  const project = top?.projectV2 ?? null
  if (!project || typeof project.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  const pageInfo = project.views?.pageInfo
  const views = (project.views?.nodes ?? []).filter((v): v is RawProjectView => v !== null)
  return {
    ok: true,
    project: { id: project.id, title: project.title ?? '', url: project.url ?? '' },
    views,
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null
  }
}

async function fetchViewFieldsContinuation(
  viewId: string,
  after: string,
  host?: string
): Promise<
  { ok: true; fields: RawProjectV2Field[] } | { ok: false; error: GitHubProjectViewError }
> {
  // Why: address the view directly via node(id:) instead of re-walking all views each page — one round-trip per field page.
  const query = `
    query($after:String!, $viewId:ID!) {
      node(id:$viewId) {
        ... on ProjectV2View {
          id
          fields(first:${FIELDS_PAGE_SIZE}, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes { ...FieldConfig }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const collected: RawProjectV2Field[] = []
  let cursor: string | null = after
  while (cursor !== null) {
    const res = await runGraphql<{
      node?: {
        id?: string
        fields?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: (RawProjectV2Field | null)[]
        }
      } | null
    }>(query, { viewId, after: cursor }, projectGhExecOptions(host))
    if (!res.ok) {
      return res
    }
    const view = res.data.node ?? null
    if (!view) {
      return { ok: false, error: driftError('view disappeared during field pagination') }
    }
    const nodes = (view.fields?.nodes ?? []).filter((f): f is RawProjectV2Field => f !== null)
    collected.push(...nodes)
    const pi = view.fields?.pageInfo
    cursor = pi?.hasNextPage === true && typeof pi.endCursor === 'string' ? pi.endCursor : null
  }
  return { ok: true, fields: collected }
}

function finalizeView(
  raw: RawProjectView,
  extraFields: RawProjectV2Field[]
): { ok: true; view: GitHubProjectView } | { ok: false; drift: GitHubProjectViewError } {
  if (typeof raw.id !== 'string' || typeof raw.layout !== 'string') {
    return { ok: false, drift: driftError('view missing id or layout') }
  }
  const layout = raw.layout as GitHubProjectViewLayout
  const fields: GitHubProjectField[] = []
  const all = [...(raw.fields?.nodes ?? []), ...extraFields.map((f) => f as RawProjectV2Field)]
  for (const f of all) {
    const n = normalizeField(f)
    if (n) {
      fields.push(n)
    }
  }
  const groupByFields: GitHubProjectField[] = []
  for (const f of raw.groupByFields?.nodes ?? []) {
    const n = normalizeField(f)
    if (n) {
      groupByFields.push(n)
    }
  }
  const sortByFields: GitHubProjectSort[] = []
  for (const s of raw.sortByFields?.nodes ?? []) {
    if (!s || (s.direction !== 'ASC' && s.direction !== 'DESC')) {
      continue
    }
    const n = normalizeField(s.field)
    if (n) {
      sortByFields.push({ direction: s.direction, field: n })
    }
  }
  return {
    ok: true,
    view: {
      id: raw.id,
      number: typeof raw.number === 'number' ? raw.number : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      layout,
      // Why: `ProjectV2View.filter` is nullable — normalize to ''.
      filter: typeof raw.filter === 'string' ? raw.filter : '',
      fields,
      groupByFields,
      sortByFields
    }
  }
}

// ─── View selection ───────────────────────────────────────────────────

function matchesSelector(
  raw: RawProjectView,
  sel: { viewId?: string; viewNumber?: number; viewName?: string }
): 'none' | 'id' | 'number' | 'name' | 'default' {
  if (sel.viewId && raw.id === sel.viewId) {
    return 'id'
  }
  if (sel.viewNumber !== undefined && raw.number === sel.viewNumber) {
    return 'number'
  }
  if (sel.viewName && raw.name === sel.viewName) {
    return 'name'
  }
  if (
    sel.viewId === undefined &&
    sel.viewNumber === undefined &&
    sel.viewName === undefined &&
    raw.layout === 'TABLE_LAYOUT'
  ) {
    return 'default'
  }
  return 'none'
}

// ─── Items fetch (paginated) ──────────────────────────────────────────

type RawItemsPage = {
  totalCount?: number
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  nodes?: (RawItem | null)[]
}

// Why: unlike runGraphql, return the raw GraphQL error envelope so the parent-field retry decision can re-inspect it.
async function fetchItemsPageWithRaw(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  first: number
  after: string | null
  includeParent: boolean
  host?: string
}): Promise<
  | { ok: true; page: RawItemsPage }
  | {
      ok: false
      error: GitHubProjectViewError
      rawErrors: GhGraphqlErrorShape[]
      stderr: string
    }
> {
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError, rawErrors: [], stderr: '' }
  }
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!, $q:String!, $first:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:$first${afterArg}, query:$q, orderBy:{ field: POSITION, direction: ASC }) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              updatedAt
              content { ${itemContentSelection(args.includeParent)} }
              ${FIELD_VALUES_SELECTION}
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const argsArr: string[] = ['api', 'graphql', '-f', `query=${query}`]
  argsArr.push('-f', `owner=${args.owner}`)
  argsArr.push('-F', `num=${args.projectNumber}`)
  argsArr.push('-f', `q=${args.query}`)
  argsArr.push('-F', `first=${args.first}`)
  if (args.after) {
    argsArr.push('-f', `after=${args.after}`)
  }

  // Why: GHES traffic runs against its own quota — only github.com requests
  // consult/debit the shared snapshot.
  const guard = repositoryRateLimitGuard(args, 'graphql')
  if (guard.blocked) {
    return {
      ok: false,
      error: rateLimitedError(guard),
      rawErrors: [],
      stderr: ''
    }
  }
  await acquire()
  noteRepositoryRateLimitSpend(args, 'graphql')
  try {
    let stdout = ''
    let stderr = ''
    let execFailed = false
    try {
      const r = await ghExecFileAsync(argsArr, {
        encoding: 'utf-8',
        ...projectGhExecOptions(args.host)
      })
      stdout = r.stdout
      stderr = r.stderr
    } catch (err) {
      const extracted = extractExecError(err)
      stderr = extracted.stderr
      stdout = extracted.stdout
      execFailed = true
    }
    let parsed: { data?: Record<string, unknown>; errors?: GhGraphqlErrorShape[] } = {}
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // Why: gh exited non-zero with unparseable stdout; classify against stderr so callers see the real cause, not a synthesized drift/not-found.
      if (execFailed) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout, args.host),
          rawErrors: [],
          stderr
        }
      }
      return {
        ok: false,
        error: driftError('failed to parse items response'),
        rawErrors: [],
        stderr
      }
    }
    // Why: gh rejected but stdout parsed; fall through to parsed.errors below, else surface the stderr classification rather than not_found.
    if (execFailed && (!parsed.errors || parsed.errors.length === 0) && !parsed.data) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout, args.host),
        rawErrors: [],
        stderr
      }
    }
    if (parsed.errors && parsed.errors.length > 0) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout, args.host),
        rawErrors: parsed.errors,
        stderr
      }
    }
    const top = parsed.data?.[root] as { projectV2?: { items?: RawItemsPage } | null } | undefined
    const page = top?.projectV2?.items
    if (!page) {
      return {
        ok: false,
        error: { type: 'not_found', message: 'Project or view not found.' },
        rawErrors: [],
        stderr
      }
    }
    return { ok: true, page }
  } finally {
    release()
  }
}

async function fetchAllItems(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<
  | { ok: true; rows: GitHubProjectRow[]; totalCount: number; parentFieldDropped: boolean }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
> {
  // Why: isolate missing Issue.parent capability by owner, type, and host.
  const scopeKey = ownerScopeKey(args.owner, args.ownerType, args.host)
  // Why: await the same-scope probe, then re-read state because it may have changed.
  const inFlight = parentFieldProbeInFlight.get(scopeKey)
  if (inFlight) {
    await inFlight.catch(() => {})
  }
  let includeParent = !hasParentFieldRetried(scopeKey)
  let parentFieldDropped = !includeParent
  // Single-flight the with-parent probe per owner; assign the in-flight promise synchronously (no await between get() and set()) so callers share one probe.
  let first: Awaited<ReturnType<typeof fetchItemsPageWithRaw>>
  let probePromise: Promise<Awaited<ReturnType<typeof fetchItemsPageWithRaw>>> | null = null
  if (includeParent && !parentFieldProbeInFlight.has(scopeKey)) {
    let resolveProbe: () => void = () => {}
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    parentFieldProbeInFlight.set(scopeKey, probe)
    probePromise = (async () => {
      try {
        const result = await fetchItemsPageWithRaw({
          owner: args.owner,
          ownerType: args.ownerType,
          projectNumber: args.projectNumber,
          query: args.query,
          first: ITEM_PAGE_SIZE,
          after: null,
          includeParent: true,
          host: args.host
        })
        // Why: set the retried flag BEFORE resolving/clearing the probe so siblings awoken on inFlight.catch() see it and don't fire duplicate with-parent probes.
        if (!result.ok && errorsIndicateParentField(result.rawErrors, result.stderr)) {
          markParentFieldRetried(scopeKey)
        }
        return result
      } finally {
        resolveProbe()
        parentFieldProbeInFlight.delete(scopeKey)
      }
    })()
    first = await probePromise
  } else {
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent,
      host: args.host
    })
  }
  if (!first.ok && includeParent && errorsIndicateParentField(first.rawErrors, first.stderr)) {
    // Retry the whole table without parent; mark this owner retried so later fetches skip the probe (other owners unaffected).
    markParentFieldRetried(scopeKey)
    includeParent = false
    parentFieldDropped = true
    if (!hasParentFieldWarningLogged(scopeKey)) {
      console.warn(
        `[project-view] Issue.parent is not available for ${args.owner} on this token — retrying without the parent selection.`
      )
      markParentFieldWarningLogged(scopeKey)
    }
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent: false,
      host: args.host
    })
  }
  if (!first.ok) {
    return { ok: false, error: first.error }
  }

  // Drift guards
  if (first.page.totalCount === undefined || first.page.totalCount === null) {
    return { ok: false, error: driftError('items.totalCount missing') }
  }
  const totalCount = first.page.totalCount
  if (first.page.pageInfo?.hasNextPage === undefined) {
    return { ok: false, error: driftError('items.pageInfo.hasNextPage missing'), totalCount }
  }
  if (!Array.isArray(first.page.nodes)) {
    return { ok: false, error: driftError('items.nodes missing'), totalCount }
  }

  // Size cap
  if (totalCount > MAX_ITEMS) {
    return {
      ok: false,
      error: { type: 'too_large', message: `View has ${totalCount} items.` },
      totalCount
    }
  }

  const rows: GitHubProjectRow[] = []
  let position = 0
  const appendNodes = (nodes: (RawItem | null)[]): GitHubProjectViewError | null => {
    for (const n of nodes) {
      if (!n) {
        continue
      }
      const norm = normalizeItem(n, position)
      if (!norm.ok) {
        return norm.drift
      }
      rows.push(norm.row)
      position++
    }
    return null
  }
  const e1 = appendNodes(first.page.nodes)
  if (e1) {
    return { ok: false, error: e1, totalCount }
  }

  // Paginate
  let hasNext = first.page.pageInfo.hasNextPage === true
  let cursor: string | null | undefined = first.page.pageInfo.endCursor
  if (hasNext && typeof cursor !== 'string') {
    return {
      ok: false,
      error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
      totalCount
    }
  }
  while (hasNext) {
    const next = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: cursor as string,
      includeParent,
      host: args.host
    })
    if (!next.ok) {
      return { ok: false, error: next.error, totalCount }
    }
    if (!Array.isArray(next.page.nodes)) {
      return { ok: false, error: driftError('items.nodes missing on follow page'), totalCount }
    }
    if (next.page.pageInfo?.hasNextPage === undefined) {
      return {
        ok: false,
        error: driftError('items.pageInfo.hasNextPage missing on follow page'),
        totalCount
      }
    }
    const e2 = appendNodes(next.page.nodes)
    if (e2) {
      return { ok: false, error: e2, totalCount }
    }
    hasNext = next.page.pageInfo.hasNextPage === true
    cursor = next.page.pageInfo.endCursor
    if (hasNext && typeof cursor !== 'string') {
      return {
        ok: false,
        error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
        totalCount
      }
    }
  }
  return { ok: true, rows, totalCount, parentFieldDropped }
}

// ─── Cheap count-only query (for unsupported_layout) ──────────────────

async function fetchItemsCountOnly(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<number | null> {
  const root = ownerQueryRoot(args.ownerType)
  const query = `
    query($owner:String!, $num:Int!, $q:String!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:1, query:$q) { totalCount }
        }
      }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { items?: { totalCount?: number } | null } | null } | null>
  >(
    query,
    { owner: args.owner, num: args.projectNumber, q: args.query },
    projectGhExecOptions(args.host)
  )
  if (!res.ok) {
    return null
  }
  const count = res.data[root]?.projectV2?.items?.totalCount
  return typeof count === 'number' ? count : null
}

// ─── Public: getProjectViewTable ──────────────────────────────────────

export async function getProjectViewTable(
  args: GetProjectViewTableArgs
): Promise<GetProjectViewTableResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {
    return { ok: false, error: numCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Invalid ownerType.' }
    }
  }

  // Paginate views until a match is found.
  let cursor: string | null = null
  let project: { id: string; title: string; url: string } | null = null
  let selectedRaw: RawProjectView | null = null
  let matchStrength: 'id' | 'number' | 'name' | 'default' | null = null
  const viewsSeen: RawProjectView[] = []
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    project = page.project
    for (const v of page.views) {
      viewsSeen.push(v)
      const m = matchesSelector(v, {
        viewId: args.viewId,
        viewNumber: args.viewNumber,
        viewName: args.viewName
      })
      if (m === 'none') {
        continue
      }
      // Precedence: id > number > name > default.
      const rank: Record<typeof m, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[m] > currentRank) {
        selectedRaw = v
        matchStrength = m
      }
    }
    // Why: stop on ANY match (incl. 'default' = first table view); walking further pages costs a GraphQL call per page with no re-ranking upside.
    if (selectedRaw) {
      break
    }
    if (!page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  if (!project) {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  if (!selectedRaw) {
    return { ok: false, error: { type: 'not_found', message: 'Could not find the selected view.' } }
  }

  // Paginate view fields if necessary.
  let extraFields: RawProjectV2Field[] = []
  const fieldsPi = selectedRaw.fields?.pageInfo
  if (fieldsPi?.hasNextPage === true && typeof fieldsPi.endCursor === 'string' && selectedRaw.id) {
    const cont = await fetchViewFieldsContinuation(selectedRaw.id, fieldsPi.endCursor, args.host)
    if (!cont.ok) {
      return { ok: false, error: cont.error }
    }
    extraFields = cont.fields
  }

  const finalized = finalizeView(selectedRaw, extraFields)
  if (!finalized.ok) {
    return { ok: false, error: finalized.drift }
  }
  const selectedView = finalized.view

  // Why: empty-string override means "no filter"; undefined means "use the view's stored filter". The override is ephemeral, never persisted.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  // Unsupported layout: skip item pagination; best-effort count-only query.
  if (selectedView.layout !== 'TABLE_LAYOUT') {
    const count = await fetchItemsCountOnly({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: effectiveQuery,
      host: args.host
    })
    return {
      ok: false,
      error: {
        type: 'unsupported_layout',
        message: `Orca only renders table views. This is a ${selectedView.layout.replace('_LAYOUT', '').toLowerCase()} view.`
      },
      ...(typeof count === 'number' ? { totalCount: count } : {})
    }
  }

  // Fetch items.
  const items = await fetchAllItems({
    owner: args.owner,
    ownerType: args.ownerType,
    projectNumber: args.projectNumber,
    query: effectiveQuery,
    host: args.host
  })
  if (!items.ok) {
    return {
      ok: false,
      error: items.error,
      ...(typeof items.totalCount === 'number' ? { totalCount: items.totalCount } : {})
    }
  }

  const table: GitHubProjectTable = {
    project: {
      id: project.id,
      host: githubProjectHost(args.host),
      owner: args.owner,
      ownerType: args.ownerType,
      number: args.projectNumber,
      title: project.title,
      url: project.url
    },
    selectedView,
    rows: items.rows,
    totalCount: items.totalCount,
    parentFieldDropped: items.parentFieldDropped
  }
  return { ok: true, data: table }
}

// ─── listAccessibleProjects ────────────────────────────────────────────

type RawViewerDiscovery = {
  viewer?: {
    login?: string
    projectsV2?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        id?: string
        number?: number
        title?: string
        url?: string
        owner?: { __typename?: string; login?: string }
      } | null)[]
    }
    organizations?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        login?: string
        projectsV2?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: ({ id?: string; number?: number; title?: string; url?: string } | null)[]
        }
      } | null)[]
    }
  }
}

export async function listAccessibleProjects(
  args?: ListAccessibleProjectsArgs
): Promise<ListAccessibleProjectsResult> {
  const host = githubProjectHost(args?.host)
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  // Why: collect per-org failures so the picker shows a "some orgs didn't load" banner instead of aborting discovery on the first 504.
  const partialFailures: { owner: string; message: string }[] = []
  let viewerLogin: string | null = null

  // 1) Viewer projects (paginated, single owner so cap at DISCOVERY_PROJECTS_PER_OWNER total).
  let viewerCursor: string | null = null
  let viewerMore = true
  let viewerFetched = 0
  while (viewerMore && viewerFetched < DISCOVERY_PROJECTS_PER_OWNER) {
    const afterArg = viewerCursor ? ', after: $after' : ''
    const afterVar = viewerCursor ? '$after:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          login
          projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number title url
              owner { __typename ... on Organization { login } ... on User { login } }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (viewerCursor) {
      vars.after = viewerCursor
    }
    const res = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      // Why: viewer-level failure is structural (no projects to build on), so propagate hard; org-level errors below are non-fatal.
      return { ok: false, error: res.error }
    }
    if (!res.data.viewer) {
      return { ok: false, error: driftError('viewer missing') }
    }
    if (viewerLogin === null) {
      viewerLogin = res.data.viewer.login ?? null
    }
    const nodes = res.data.viewer.projectsV2?.nodes ?? []
    for (const n of nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {
        continue
      }
      const ownerLogin = n.owner?.login ?? viewerLogin ?? ''
      const ownerType: GitHubProjectOwnerType =
        n.owner?.__typename === 'Organization' ? 'organization' : 'user'
      viewerProjects.push({
        id: n.id,
        host,
        owner: ownerLogin,
        ownerType,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        source: 'viewer'
      })
      viewerFetched++
      if (viewerFetched >= DISCOVERY_PROJECTS_PER_OWNER) {
        break
      }
    }
    const pi = res.data.viewer.projectsV2?.pageInfo
    viewerMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    viewerCursor = viewerMore ? (pi?.endCursor ?? null) : null
  }

  // 2) Organizations the viewer belongs to, each with its projectsV2.
  // Why: no per-org projectsV2 continuation loop — it was the dominant 504 cost; users past the cap can paste a URL instead.
  let orgCursor: string | null = null
  let orgMore = true
  let orgsSeen = 0
  while (orgMore && orgsSeen < DISCOVERY_MAX_ORGS) {
    const afterArg = orgCursor ? ', after: $orgAfter' : ''
    const afterVar = orgCursor ? '$orgAfter:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          organizations(first:${DISCOVERY_ORG_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              login
              projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}) {
                pageInfo { hasNextPage endCursor }
                nodes { id number title url }
              }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (orgCursor) {
      vars.orgAfter = orgCursor
    }
    const res = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      // Why: org-listing failed; record a synthetic '*' partial failure so the banner explains it, but keep collected viewer projects (the reported 504 path).
      partialFailures.push({ owner: '*', message: res.error.message })
      break
    }
    const orgs = res.data.viewer?.organizations?.nodes ?? []
    for (const org of orgs) {
      if (!org || typeof org.login !== 'string') {
        continue
      }
      if (orgsSeen >= DISCOVERY_MAX_ORGS) {
        break
      }
      orgsSeen++
      const login = org.login
      // Cache for paste/resolve even when the nested projects query was empty or partially failed.
      rememberOwnerType(login, 'organization', host)
      const nodes = org.projectsV2?.nodes ?? []
      let ownerCount = 0
      for (const n of nodes) {
        if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {
          continue
        }
        if (ownerCount >= DISCOVERY_PROJECTS_PER_OWNER) {
          break
        }
        orgProjects.push({
          id: n.id,
          host,
          owner: login,
          ownerType: 'organization',
          number: n.number,
          title: n.title ?? '',
          url: n.url ?? '',
          source: `org:${login}`
        })
        ownerCount++
      }
    }
    const pi = res.data.viewer?.organizations?.pageInfo
    orgMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    orgCursor = orgMore ? (pi?.endCursor ?? null) : null
  }

  if (viewerLogin) {
    rememberOwnerType(viewerLogin, 'user', host)
  }

  return {
    ok: true,
    projects: [...viewerProjects, ...orgProjects],
    ...(partialFailures.length > 0 ? { partialFailures } : {})
  }
}

// ─── resolveProjectRef ─────────────────────────────────────────────────

type ParsedPaste =
  | { kind: 'org'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'user'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'bare'; owner: string; number: number }

export function parseProjectPaste(input: string, host?: string): ParsedPaste | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  if (isGitHubProjectRefInputTooLarge(trimmed)) {
    return null
  }
  // Why: URL parsing enforces an exact Project path and rejects credentials;
  // a prefix regex could silently turn `/projects/1evil` into Project 1.
  try {
    const url = new URL(trimmed)
    const allowedHosts = new Set(['github.com', ...(host ? [host.trim().toLowerCase()] : [])])
    const parts = url.pathname.split('/').filter(Boolean)
    const hasView = parts.length === 6 && parts[4] === 'views'
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.host.toLowerCase()) ||
      (parts[0] !== 'orgs' && parts[0] !== 'users') ||
      !isValidOwnerSlug(parts[1]) ||
      parts[2] !== 'projects' ||
      (parts.length !== 4 && !hasView)
    ) {
      return null
    }
    const number = Number(parts[3])
    const viewNumber = hasView ? Number(parts[5]) : undefined
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (hasView && (!Number.isSafeInteger(viewNumber) || (viewNumber ?? 0) < 1))
    ) {
      return null
    }
    return {
      kind: parts[0] === 'orgs' ? 'org' : 'user',
      owner: parts[1],
      number,
      host: url.host.toLowerCase(),
      ...(viewNumber !== undefined ? { viewNumber } : {})
    }
  } catch {
    // Shorthand parsing below remains available for non-URL input.
  }
  // owner/number shorthand — owner alphabet matches OWNER_SLUG_RE.
  const shortRe = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/
  const sm = trimmed.match(shortRe)
  if (sm) {
    const number = Number.parseInt(sm[2], 10)
    if (!Number.isInteger(number) || number < 1) {
      return null
    }
    return { kind: 'bare', owner: sm[1], number }
  }
  return null
}

async function resolveOwnerType(
  owner: string,
  preferred: GitHubProjectOwnerType | null,
  host?: string
): Promise<
  | { ok: true; ownerType: GitHubProjectOwnerType; title: string }
  | { ok: false; error: GitHubProjectViewError }
> {
  const tryOne = async (
    ot: GitHubProjectOwnerType,
    num: number | null
  ): Promise<{ ok: true; title: string } | { ok: false; error: GitHubProjectViewError }> => {
    const root = ownerQueryRoot(ot)
    // If number is provided, fetch the project title; else just confirm owner exists.
    const query = num
      ? `
        query($owner:String!, $num:Int!) {
          ${root}(login:$owner) { projectV2(number:$num) { id title } }
        }
      `
      : `
        query($owner:String!) {
          ${root}(login:$owner) { login }
        }
      `
    const vars: GraphqlVars = { owner }
    if (num) {
      vars.num = num
    }
    const res = await runGraphql<
      Record<string, { projectV2?: { id?: string; title?: string } | null; login?: string } | null>
    >(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      return { ok: false, error: res.error }
    }
    const top = res.data[root]
    if (!top) {
      return { ok: false, error: { type: 'not_found', message: 'Owner not found.' } }
    }
    if (num) {
      const p = top.projectV2
      if (!p || typeof p.id !== 'string') {
        return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
      }
      return { ok: true, title: p.title ?? '' }
    }
    return { ok: true, title: '' }
  }

  const cached = getCachedOwnerType(owner, host)
  const candidates: GitHubProjectOwnerType[] = preferred
    ? [preferred]
    : cached
      ? [cached]
      : ['organization', 'user']
  const fallback: GitHubProjectOwnerType[] = preferred
    ? []
    : cached
      ? cached === 'organization'
        ? ['user']
        : ['organization']
      : []
  const ordered = [...candidates, ...fallback]
  let lastError: GitHubProjectViewError | null = null
  for (const ot of ordered) {
    const r = await tryOne(ot, null)
    if (r.ok) {
      rememberOwnerType(owner, ot, host)
      return { ok: true, ownerType: ot, title: r.title }
    }
    lastError = r.error
    if (r.error.type !== 'not_found') {
      // Non-NOT_FOUND errors (auth, network, rate) should not trigger fallback.
      return { ok: false, error: r.error }
    }
  }
  rememberOwnerType(owner, null, host)
  return {
    ok: false,
    error: lastError ?? { type: 'not_found', message: 'Owner not found.' }
  }
}

export async function resolveProjectRef(
  args: ResolveProjectRefArgs
): Promise<ResolveProjectRefResult> {
  const input = typeof args.input === 'string' ? args.input.trim() : ''
  if (!input) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Input required.' }
    }
  }
  if (isGitHubProjectRefInputTooLarge(input)) {
    return {
      ok: false,
      error: { type: 'validation_error', message: GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR }
    }
  }
  const parsed = parseProjectPaste(input, args.host)
  if (!parsed) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      }
    }
  }
  const preferred: GitHubProjectOwnerType | null =
    parsed.kind === 'org' ? 'organization' : parsed.kind === 'user' ? 'user' : null
  // Why: a pasted URL is authoritative. The ambient host only applies to
  // owner/number shorthand; otherwise same-number Projects can cross hosts.
  const executionHost = parsed.kind === 'bare' ? githubProjectHost(args.host) : parsed.host
  // Verify by fetching project title.
  const ownerRes = await resolveOwnerType(parsed.owner, preferred, executionHost)
  if (!ownerRes.ok) {
    return { ok: false, error: ownerRes.error }
  }
  const ownerType = ownerRes.ownerType
  const root = ownerQueryRoot(ownerType)
  const query = `
    query($owner:String!, $num:Int!) {
      ${root}(login:$owner) { projectV2(number:$num) { id title } }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { id?: string; title?: string } | null } | null>
  >(query, { owner: parsed.owner, num: parsed.number }, projectGhExecOptions(executionHost))
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  const p = res.data[root]?.projectV2
  if (!p || typeof p.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  return {
    ok: true,
    owner: parsed.owner,
    ownerType,
    number: parsed.number,
    title: p.title ?? '',
    host: executionHost,
    // Why: forward URL view numbers so the renderer can skip view selection; bare shorthand has none.
    ...(parsed.kind !== 'bare' && parsed.viewNumber !== undefined
      ? { viewNumber: parsed.viewNumber }
      : {})
  }
}

// ─── listProjectViews ──────────────────────────────────────────────────

export async function listProjectViews(
  args: ListProjectViewsArgs
): Promise<ListProjectViewsResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {
    return { ok: false, error: numCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid ownerType.' } }
  }
  const summaries: GitHubProjectViewSummary[] = []
  let cursor: string | null = null
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    for (const v of page.views) {
      if (typeof v.id !== 'string' || typeof v.layout !== 'string') {
        continue
      }
      summaries.push({
        id: v.id,
        number: typeof v.number === 'number' ? v.number : 0,
        name: typeof v.name === 'string' ? v.name : '',
        layout: v.layout as GitHubProjectViewLayout
      })
    }
    if (!page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  return { ok: true, views: summaries }
}
