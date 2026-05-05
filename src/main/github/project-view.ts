/* eslint-disable max-lines -- Why: ProjectV2 GraphQL has its own normalization
layer, retry policy (parent-field dance), paste-to-add parser, and discovery
pagination. Co-locating the read path keeps the retry/classify/normalize
contract reviewable as one surface. Lower-level plumbing (slug validation,
error classifier, runGraphql/runRest) lives in ./project-view/internals; the
slug-addressed write path lives in ./project-view/mutations. */
import {
  acquire,
  release,
  extractExecError,
  ghExecFileAsync,
  rateLimitGuard,
  noteRateLimitSpend,
  classifyProjectError,
  driftError,
  errorsIndicateParentField,
  rateLimitedError,
  runGraphql,
  isValidOwnerSlug,
  assertSlug,
  assertPositiveInt,
  type GhGraphqlErrorShape,
  type GraphqlVars
} from './project-view/internals'
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
  ListAccessibleProjectsResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult
} from '../../shared/github-project-types'

// Re-export the public API so existing call sites (`./project-view`) keep
// working unchanged. The split is internal-only.
export {
  isValidOwnerSlug,
  isValidRepoSlug,
  isValidSlug,
  classifyProjectError
} from './project-view/internals'
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

// Why: these defaults were deliberately shrunk from 50/50/100 to cut quota
// spend in the most expensive gh call reachable from TaskPage. Discovery
// walks viewer projects, then up to `DISCOVERY_MAX_ORGS` orgs × a nested
// `projectsV2(first:N)` query. The org loop dominates the cost and is the
// path that produced the user-visible HTTP 504 when one org was slow. Users
// with projects outside this window can still paste a URL to reach them —
// no functional loss. Prior values: MAX_ORGS=50, ORG_PAGE_SIZE=30,
// PROJECTS_PER_OWNER=100, nested projectsV2 first=50.
const ITEM_PAGE_SIZE = 100
const MAX_ITEMS = 500
const VIEWS_PAGE_SIZE = 20
const FIELDS_PAGE_SIZE = 50
const DISCOVERY_PROJECTS_PER_OWNER = 40
const DISCOVERY_MAX_ORGS = 20
const DISCOVERY_ORG_PAGE_SIZE = 20
const DISCOVERY_PROJECTS_PER_ORG = 20
const FIELD_VALUES_PAGE_SIZE = 100

// ─── Module-scope caches (reset on HMR — intentional) ──────────────────

// Why: HMR reloading should re-probe capability. Both caches live as plain
// module locals so a dev-time code swap naturally re-runs capability probes
// instead of carrying a stale "unsupported" flag into fresh code.
const ownerTypeCache = new Map<string, GitHubProjectOwnerType | null>()
let parentFieldRetried = false
let parentFieldWarningLogged = false
// Why: concurrent fetchAllItems calls all observe parentFieldRetried=false,
// each issuing a duplicate first-page probe and racing to set the flag. Use
// an in-flight promise so only one caller drives the probe; siblings await
// the same result.
let parentFieldProbeInFlight: Promise<void> | null = null

/** @internal — test-only */
export function _resetProjectViewModuleState(): void {
  ownerTypeCache.clear()
  parentFieldRetried = false
  parentFieldWarningLogged = false
  parentFieldProbeInFlight = null
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

export function normalizeField(raw: RawProjectV2Field | null | undefined): GitHubProjectField | null {
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
  if (!raw || typeof raw.login !== 'string') {return null}
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null
  }
}

type RawLabel = { name?: string; color?: string }

function normalizeLabel(raw: RawLabel | null | undefined): GitHubProjectLabel | null {
  if (!raw || typeof raw.name !== 'string') {return null}
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

export function normalizeFieldValue(raw: RawFieldValue | null | undefined): GitHubProjectFieldValue | null {
  if (!raw || !raw.field || typeof raw.field.id !== 'string') {return null}
  const fieldId = raw.field.id
  switch (raw.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      if (typeof raw.optionId !== 'string') {return null}
      return {
        kind: 'single-select',
        fieldId,
        optionId: raw.optionId,
        name: raw.name ?? '',
        color: raw.color ?? ''
      }
    case 'ProjectV2ItemFieldIterationValue':
      if (typeof raw.iterationId !== 'string') {return null}
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
      if (typeof raw.number !== 'number') {return null}
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
    default:
      // Unknown __typename → forward-compat: drop silently, do not throw,
      // do not classify as drift (see design §Error Handling).
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
  issueType?: { id?: string; name?: string; color?: string | null; description?: string | null } | null
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
  if (raw === 'ISSUE') {return 'ISSUE'}
  if (raw === 'PULL_REQUEST') {return 'PULL_REQUEST'}
  if (raw === 'DRAFT_ISSUE') {return 'DRAFT_ISSUE'}
  if (raw === 'REDACTED' || !hasContent) {return 'REDACTED'}
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
  if (args.after) {vars.after = args.after}
  const res = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
    query,
    vars
  )
  if (!res.ok) {return res}
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
  after: string
): Promise<{ ok: true; fields: RawProjectV2Field[] } | { ok: false; error: GitHubProjectViewError }> {
  // Why: address the view directly via `node(id:)` instead of re-fetching the
  // whole project + walking views every page. Previous shape paid an
  // unnecessary `${VIEWS_PAGE_SIZE}` views fan-out per field-continuation
  // page; the new shape is one round-trip per field page, which is the
  // minimum possible cost. Field-paged views are rare (>50 fields), so this
  // only matters for the few projects that hit it — but when they do, the
  // savings compound across pagination loops.
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
    }>(query, { viewId, after: cursor })
    if (!res.ok) {return res}
    const view = res.data.node ?? null
    if (!view) {
      return { ok: false, error: driftError('view disappeared during field pagination') }
    }
    const nodes = (view.fields?.nodes ?? []).filter(
      (f): f is RawProjectV2Field => f !== null
    )
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
    if (n) {fields.push(n)}
  }
  const groupByFields: GitHubProjectField[] = []
  for (const f of raw.groupByFields?.nodes ?? []) {
    const n = normalizeField(f)
    if (n) {groupByFields.push(n)}
  }
  const sortByFields: GitHubProjectSort[] = []
  for (const s of raw.sortByFields?.nodes ?? []) {
    if (!s || (s.direction !== 'ASC' && s.direction !== 'DESC')) {continue}
    const n = normalizeField(s.field)
    if (n) {sortByFields.push({ direction: s.direction, field: n })}
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
  if (sel.viewId && raw.id === sel.viewId) {return 'id'}
  if (sel.viewNumber !== undefined && raw.number === sel.viewNumber) {return 'number'}
  if (sel.viewName && raw.name === sel.viewName) {return 'name'}
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

// Why: runGraphql returns the classified error but not the raw GraphQL
// errors; for the parent-field retry decision we need those. This variant
// returns the raw envelope so callers can re-inspect.
async function fetchItemsPageWithRaw(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  first: number
  after: string | null
  includeParent: boolean
}): Promise<
  | { ok: true; page: RawItemsPage }
  | {
      ok: false
      error: GitHubProjectViewError
      rawErrors: GhGraphqlErrorShape[]
      stderr: string
    }
> {
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
  if (args.after) {argsArr.push('-f', `after=${args.after}`)}

  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    return {
      ok: false,
      error: rateLimitedError(guard),
      rawErrors: [],
      stderr: ''
    }
  }
  await acquire()
  noteRateLimitSpend('graphql')
  try {
    let stdout = ''
    let stderr = ''
    let execFailed = false
    try {
      const r = await ghExecFileAsync(argsArr, { encoding: 'utf-8' })
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
      // Why: when gh exits non-zero with no parseable JSON on stdout (network,
      // auth, rate-limit, missing scope), classify against stderr so callers
      // see the real cause instead of a synthesized drift/not-found.
      if (execFailed) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout),
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
    // Why: gh exec rejected but stdout still had a parseable error envelope —
    // fall through to the parsed.errors branch below. If parsed has neither
    // data nor errors, surface the stderr classification rather than not_found.
    if (execFailed && (!parsed.errors || parsed.errors.length === 0) && !parsed.data) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout),
        rawErrors: [],
        stderr
      }
    }
    if (parsed.errors && parsed.errors.length > 0) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout),
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
}): Promise<
  | { ok: true; rows: GitHubProjectRow[]; totalCount: number; parentFieldDropped: boolean }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
> {
  // Why: if another caller is currently probing whether Issue.parent is
  // supported, await its decision so we don't fire a duplicate with-parent
  // probe and don't capture a stale includeParent. We must re-read
  // parentFieldRetried AFTER awaiting because the probe may have flipped it.
  if (parentFieldProbeInFlight) {
    await parentFieldProbeInFlight.catch(() => {})
  }
  let includeParent = !parentFieldRetried
  let parentFieldDropped = parentFieldRetried
  // First page — single-flight the with-parent attempt so concurrent callers
  // observe one probe result instead of each issuing their own. We must
  // assign parentFieldProbeInFlight synchronously (no await between the
  // null check and the assignment) so concurrent callers race on the same
  // promise rather than each creating a duplicate probe.
  let first: Awaited<ReturnType<typeof fetchItemsPageWithRaw>>
  let probePromise: Promise<Awaited<ReturnType<typeof fetchItemsPageWithRaw>>> | null = null
  if (includeParent && !parentFieldProbeInFlight) {
    let resolveProbe: () => void = () => {}
    parentFieldProbeInFlight = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    probePromise = (async () => {
      try {
        return await fetchItemsPageWithRaw({
          owner: args.owner,
          ownerType: args.ownerType,
          projectNumber: args.projectNumber,
          query: args.query,
          first: ITEM_PAGE_SIZE,
          after: null,
          includeParent: true
        })
      } finally {
        resolveProbe()
        parentFieldProbeInFlight = null
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
      includeParent
    })
  }
  if (!first.ok && includeParent && errorsIndicateParentField(first.rawErrors, first.stderr)) {
    // Retry the whole table without parent. Set module flag so the rest of
    // the process never re-probes until HMR or restart.
    parentFieldRetried = true
    includeParent = false
    parentFieldDropped = true
    if (!parentFieldWarningLogged) {
      console.warn(
        '[project-view] Issue.parent is not available on this token — retrying without the parent selection.'
      )
      parentFieldWarningLogged = true
    }
    first = await fetchItemsPageWithRaw({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: args.query,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent: false
    })
  }
  if (!first.ok) {return { ok: false, error: first.error }}

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
    return { ok: false, error: { type: 'too_large', message: `View has ${totalCount} items.` }, totalCount }
  }

  const rows: GitHubProjectRow[] = []
  let position = 0
  const appendNodes = (nodes: (RawItem | null)[]): GitHubProjectViewError | null => {
    for (const n of nodes) {
      if (!n) {continue}
      const norm = normalizeItem(n, position)
      if (!norm.ok) {return norm.drift}
      rows.push(norm.row)
      position++
    }
    return null
  }
  const e1 = appendNodes(first.page.nodes)
  if (e1) {return { ok: false, error: e1, totalCount }}

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
      includeParent
    })
    if (!next.ok) {return { ok: false, error: next.error, totalCount }}
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
    if (e2) {return { ok: false, error: e2, totalCount }}
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
  >(query, { owner: args.owner, num: args.projectNumber, q: args.query })
  if (!res.ok) {return null}
  const count = res.data[root]?.projectV2?.items?.totalCount
  return typeof count === 'number' ? count : null
}

// ─── Public: getProjectViewTable ──────────────────────────────────────

export async function getProjectViewTable(
  args: GetProjectViewTableArgs
): Promise<GetProjectViewTableResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {return { ok: false, error: ownerCheck.error }}
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {return { ok: false, error: numCheck.error }}
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
      after: cursor
    })
    if (!page.ok) {return { ok: false, error: page.error }}
    project = page.project
    for (const v of page.views) {
      viewsSeen.push(v)
      const m = matchesSelector(v, {
        viewId: args.viewId,
        viewNumber: args.viewNumber,
        viewName: args.viewName
      })
      if (m === 'none') {continue}
      // Precedence: id > number > name > default.
      const rank: Record<typeof m, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[m] > currentRank) {
        selectedRaw = v
        matchStrength = m
      }
    }
    // Why: stop as soon as we have ANY match — including 'default' (first
    // table view). Continuing to walk views pages for a default selector
    // costs one extra GraphQL call per page with no upside: the default
    // contract is "first table view we see", and view layouts don't change
    // ordering between pages such that a later view would outrank the
    // first table layout. Previously we kept walking on default match
    // because the precedence comment hinted at re-ranking, but no real
    // selector promotes a 'default' to a stronger match within the same
    // selector input — those ranks only matter when the caller supplied
    // a selector. Bail early on any non-null selectedRaw.
    if (selectedRaw) {break}
    if (!page.hasNextPage) {break}
    cursor = page.endCursor
    if (typeof cursor !== 'string') {break}
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
    const cont = await fetchViewFieldsContinuation(selectedRaw.id, fieldsPi.endCursor)
    if (!cont.ok) {return { ok: false, error: cont.error }}
    extraFields = cont.fields
  }

  const finalized = finalizeView(selectedRaw, extraFields)
  if (!finalized.ok) {return { ok: false, error: finalized.drift }}
  const selectedView = finalized.view

  // Why: an explicit empty-string override means "no filter"; treat undefined
  // as "use the view's filter as-is". The override is ephemeral — never
  // persisted to GitHub — so users can clear the search without mutating the
  // view's stored filter.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  // Unsupported layout: return without paginating items; attempt a cheap
  // count-only query best-effort.
  if (selectedView.layout !== 'TABLE_LAYOUT') {
    const count = await fetchItemsCountOnly({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: effectiveQuery
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
    query: effectiveQuery
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

export async function listAccessibleProjects(): Promise<ListAccessibleProjectsResult> {
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  // Why: per-org failures are collected so the picker can render a "some orgs
  // didn't load" banner with the affected logins, instead of aborting the
  // whole discovery on the first 504. Users with flaky org fetches still get
  // viewer + other orgs in the list.
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
    if (viewerCursor) {vars.after = viewerCursor}
    const res = await runGraphql<RawViewerDiscovery>(query, vars)
    if (!res.ok) {
      // Why: a viewer-level failure is structural — if we can't list the
      // user's own projects, we have nothing to build on. Propagate as a
      // hard error instead of returning partial. Org-level errors below
      // are non-fatal because the viewer slice is still useful on its own.
      return { ok: false, error: res.error }
    }
    if (!res.data.viewer) {
      return { ok: false, error: driftError('viewer missing') }
    }
    if (viewerLogin === null) {viewerLogin = res.data.viewer.login ?? null}
    const nodes = res.data.viewer.projectsV2?.nodes ?? []
    for (const n of nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {continue}
      const ownerLogin = n.owner?.login ?? viewerLogin ?? ''
      const ownerType: GitHubProjectOwnerType =
        n.owner?.__typename === 'Organization' ? 'organization' : 'user'
      viewerProjects.push({
        id: n.id,
        owner: ownerLogin,
        ownerType,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        source: 'viewer'
      })
      viewerFetched++
      if (viewerFetched >= DISCOVERY_PROJECTS_PER_OWNER) {break}
    }
    const pi = res.data.viewer.projectsV2?.pageInfo
    viewerMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    viewerCursor = viewerMore ? (pi?.endCursor ?? null) : null
  }

  // 2) Organizations the viewer belongs to, each with its projectsV2.
  // Why: we intentionally drop the per-org continuation loop that previously
  // ran `organization(login).projectsV2(first:50, after:$after)` when the
  // first nested page had more. That inner loop was the dominant cost
  // multiplier and the most common 504 source — a single slow org would
  // serially block the picker for tens of seconds. Users with more than
  // DISCOVERY_PROJECTS_PER_ORG projects in a given org can still paste a
  // URL to reach them; the picker is discovery, not an exhaustive index.
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
    if (orgCursor) {vars.orgAfter = orgCursor}
    const res = await runGraphql<RawViewerDiscovery>(query, vars)
    if (!res.ok) {
      // Why: the org-listing query itself failed (not a nested projectsV2).
      // Record it as a partial failure against a synthetic `*` owner so the
      // UI banner explains why additional orgs aren't listed, but keep any
      // viewer projects we already collected. This is the critical 504 path
      // the user reported in the ProjectPicker.
      partialFailures.push({ owner: '*', message: res.error.message })
      break
    }
    const orgs = res.data.viewer?.organizations?.nodes ?? []
    for (const org of orgs) {
      if (!org || typeof org.login !== 'string') {continue}
      if (orgsSeen >= DISCOVERY_MAX_ORGS) {break}
      orgsSeen++
      const login = org.login
      // Cache owner → ownerType for downstream paste/resolve even when the
      // nested projects query was empty or partially failed — paste-to-add
      // uses this to disambiguate /orgs/ vs /users/ URLs.
      ownerTypeCache.set(login, 'organization')
      const nodes = org.projectsV2?.nodes ?? []
      let ownerCount = 0
      for (const n of nodes) {
        if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {continue}
        if (ownerCount >= DISCOVERY_PROJECTS_PER_OWNER) {break}
        orgProjects.push({
          id: n.id,
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

  if (viewerLogin) {ownerTypeCache.set(viewerLogin, 'user')}

  return {
    ok: true,
    projects: [...viewerProjects, ...orgProjects],
    ...(partialFailures.length > 0 ? { partialFailures } : {})
  }
}

// ─── resolveProjectRef ─────────────────────────────────────────────────

type ParsedPaste =
  | { kind: 'org'; owner: string; number: number; viewNumber?: number }
  | { kind: 'user'; owner: string; number: number; viewNumber?: number }
  | { kind: 'bare'; owner: string; number: number }

export function parseProjectPaste(input: string): ParsedPaste | null {
  const trimmed = input.trim()
  if (!trimmed) {return null}
  // URL forms
  const urlRe = /^https?:\/\/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)(?:\/views\/(\d+))?/i
  const m = trimmed.match(urlRe)
  if (m) {
    const [, kindSeg, owner, nStr, vStr] = m
    const number = parseInt(nStr, 10)
    if (!Number.isInteger(number) || number < 1) {return null}
    if (!isValidOwnerSlug(owner)) {return null}
    const viewNumber = vStr ? parseInt(vStr, 10) : undefined
    return {
      kind: kindSeg === 'orgs' ? 'org' : 'user',
      owner,
      number,
      ...(viewNumber !== undefined && Number.isInteger(viewNumber) && viewNumber >= 1
        ? { viewNumber }
        : {})
    }
  }
  // owner/number shorthand — owner alphabet matches OWNER_SLUG_RE.
  const shortRe = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/
  const sm = trimmed.match(shortRe)
  if (sm) {
    const number = parseInt(sm[2], 10)
    if (!Number.isInteger(number) || number < 1) {return null}
    return { kind: 'bare', owner: sm[1], number }
  }
  return null
}

async function resolveOwnerType(
  owner: string,
  preferred: GitHubProjectOwnerType | null
): Promise<
  { ok: true; ownerType: GitHubProjectOwnerType; title: string }
  | { ok: false; error: GitHubProjectViewError }
> {
  const tryOne = async (
    ot: GitHubProjectOwnerType,
    num: number | null
  ): Promise<
    { ok: true; title: string } | { ok: false; error: GitHubProjectViewError }
  > => {
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
    if (num) {vars.num = num}
    const res = await runGraphql<
      Record<string, { projectV2?: { id?: string; title?: string } | null; login?: string } | null>
    >(query, vars)
    if (!res.ok) {return { ok: false, error: res.error }}
    const top = res.data[root]
    if (!top) {return { ok: false, error: { type: 'not_found', message: 'Owner not found.' } }}
    if (num) {
      const p = top.projectV2
      if (!p || typeof p.id !== 'string') {
        return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
      }
      return { ok: true, title: p.title ?? '' }
    }
    return { ok: true, title: '' }
  }

  const cached = ownerTypeCache.get(owner)
  const candidates: GitHubProjectOwnerType[] = preferred
    ? [preferred]
    : cached
      ? [cached]
      : ['organization', 'user']
  const fallback: GitHubProjectOwnerType[] = preferred
    ? []
    : cached
      ? (cached === 'organization' ? ['user'] : ['organization'])
      : []
  const ordered = [...candidates, ...fallback]
  let lastError: GitHubProjectViewError | null = null
  for (const ot of ordered) {
    const r = await tryOne(ot, null)
    if (r.ok) {
      ownerTypeCache.set(owner, ot)
      return { ok: true, ownerType: ot, title: r.title }
    }
    lastError = r.error
    if (r.error.type !== 'not_found') {
      // Non-NOT_FOUND errors (auth, network, rate) should not trigger fallback.
      return { ok: false, error: r.error }
    }
  }
  ownerTypeCache.set(owner, null)
  return {
    ok: false,
    error: lastError ?? { type: 'not_found', message: 'Owner not found.' }
  }
}

export async function resolveProjectRef(
  args: ResolveProjectRefArgs
): Promise<ResolveProjectRefResult> {
  if (typeof args.input !== 'string' || !args.input.trim()) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Input required.' }
    }
  }
  const parsed = parseProjectPaste(args.input)
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
  // Verify by fetching project title.
  const ownerRes = await resolveOwnerType(parsed.owner, preferred)
  if (!ownerRes.ok) {return { ok: false, error: ownerRes.error }}
  const ownerType = ownerRes.ownerType
  const root = ownerQueryRoot(ownerType)
  const query = `
    query($owner:String!, $num:Int!) {
      ${root}(login:$owner) { projectV2(number:$num) { id title } }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { id?: string; title?: string } | null } | null>
  >(query, { owner: parsed.owner, num: parsed.number })
  if (!res.ok) {return { ok: false, error: res.error }}
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
    // Why: forward the parsed view number from /views/{n} URLs so the
    // renderer can skip the view-pick step. parsed.kind === 'bare' has no
    // viewNumber (owner/number shorthand carries no view).
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
  if (!ownerCheck.ok) {return { ok: false, error: ownerCheck.error }}
  const numCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numCheck.ok) {return { ok: false, error: numCheck.error }}
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
      after: cursor
    })
    if (!page.ok) {return { ok: false, error: page.error }}
    for (const v of page.views) {
      if (typeof v.id !== 'string' || typeof v.layout !== 'string') {continue}
      summaries.push({
        id: v.id,
        number: typeof v.number === 'number' ? v.number : 0,
        name: typeof v.name === 'string' ? v.name : '',
        layout: v.layout as GitHubProjectViewLayout
      })
    }
    if (!page.hasNextPage) {break}
    cursor = page.endCursor
    if (typeof cursor !== 'string') {break}
  }
  return { ok: true, views: summaries }
}
