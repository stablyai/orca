import type {
  GitHubProjectField,
  GitHubProjectOwnerType,
  GitHubProjectSort,
  GitHubProjectView,
  GitHubProjectViewLayout
} from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { driftError } from './project-error-classification'
import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import { normalizeField, type RawProjectV2Field } from './project-view-field-normalization'
import { FIELD_CONFIG_FRAGMENT } from './project-view-query-fragments'

const VIEWS_PAGE_SIZE = 20
const FIELDS_PAGE_SIZE = 50

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

export type RawProjectView = {
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
  verticalGroupByFields?: { nodes?: (RawProjectV2Field | null)[] }
  sortByFields?: {
    nodes?: ({ direction?: string; field?: RawProjectV2Field | null } | null)[]
  }
}

// Why: older GHES ProjectV2 schemas predate `verticalGroupByFields`; one
// unknown-field error there would break EVERY project view on that host. Track
// the incapability per host and retry the views query without the selection —
// the board renderer falls back to the Status field when config is absent.
const hostsWithoutVerticalGroupBy = new Set<string>()

function verticalGroupBySelection(host: string | undefined): string {
  return hostsWithoutVerticalGroupBy.has(githubProjectHost(host) ?? 'github.com')
    ? ''
    : 'verticalGroupByFields(first:10) { nodes { ...FieldConfig } }'
}

function errorsIndicateVerticalGroupBy(raw: { stderr: string; stdout: string }): boolean {
  return `${raw.stdout}\n${raw.stderr}`.includes('verticalGroupByFields')
}

export function ownerQueryRoot(ownerType: GitHubProjectOwnerType): string {
  return ownerType === 'organization' ? 'organization' : 'user'
}

export async function fetchProjectViewsPage(args: {
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
  const buildQuery = (): string => `
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
              ${verticalGroupBySelection(args.host)}
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
  let res = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
    buildQuery(),
    vars,
    projectGhExecOptions(args.host)
  )
  if (!res.ok && errorsIndicateVerticalGroupBy(res.raw)) {
    hostsWithoutVerticalGroupBy.add(githubProjectHost(args.host) ?? 'github.com')
    res = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
      buildQuery(),
      vars,
      projectGhExecOptions(args.host)
    )
  }
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

export async function fetchViewFieldsContinuation(
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

export function finalizeView(
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
  const verticalGroupByFields: GitHubProjectField[] = []
  for (const f of raw.verticalGroupByFields?.nodes ?? []) {
    const n = normalizeField(f)
    if (n) {
      verticalGroupByFields.push(n)
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
      sortByFields,
      // Why: only attach when present so old cached payloads and schema-less
      // hosts keep the exact shape the optional wire field promises.
      ...(raw.verticalGroupByFields ? { verticalGroupByFields } : {})
    }
  }
}

// ─── View selection ───────────────────────────────────────────────────

export function matchesSelector(
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
