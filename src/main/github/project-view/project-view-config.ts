import type {
  GitHubProjectField,
  GitHubProjectOwnerType,
  GitHubProjectSort,
  GitHubProjectView,
  GitHubProjectViewLayout
} from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { driftError, extractGraphqlErrors } from './project-error-classification'
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
  fields?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: (RawProjectV2Field | null)[]
  }
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

// Older GHES hosts omit vertical grouping so one missing field cannot break all views.
const hostsWithoutVerticalGroupBy = new Set<string>()

/** Test-only: capability state is module-level so real runs memoize per host. */
export function resetVerticalGroupByCapabilityForTests(): void {
  hostsWithoutVerticalGroupBy.clear()
}

function verticalGroupBySelection(host: string | undefined): string {
  return hostsWithoutVerticalGroupBy.has(githubProjectHost(host))
    ? ''
    : 'verticalGroupByFields(first:10) { nodes { ...FieldConfig } }'
}

function errorsIndicateVerticalGroupBy(raw: { stderr: string; stdout: string }): boolean {
  // Partial-error data can echo the field name even when the schema supports it.
  return extractGraphqlErrors(raw.stderr, raw.stdout).some(
    (error) =>
      /\bverticalGroupByFields\b/.test(error.message ?? '') &&
      /(?:doesn't exist|does not exist|cannot query field|unknown field|undefined field)/i.test(
        error.message ?? ''
      )
  )
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
  /** Project fields are page-independent, so only the first table page asks for them. */
  includeProjectFields?: boolean
}): Promise<
  | {
      ok: true
      project: { id: string; title: string; url: string }
      /** Every project field, including ones the views hide. */
      projectFields: GitHubProjectField[]
      /** Set when project fields continue past the first page. */
      projectFieldsEndCursor: string | null
      views: RawProjectView[]
      hasNextPage: boolean
      endCursor: string | null
    }
  | { ok: false; error: GitHubProjectViewError }
> {
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const projectFieldsSelection = args.includeProjectFields
    ? `fields(first:${FIELDS_PAGE_SIZE}) {
        pageInfo { hasNextPage endCursor }
        nodes { ...FieldConfig }
      }`
    : ''
  const buildQuery = (): string => `
    query(${afterVar}$owner:String!, $num:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          id title url
          ${projectFieldsSelection}
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
  if (!res.ok && verticalGroupBySelection(args.host) && errorsIndicateVerticalGroupBy(res.raw)) {
    hostsWithoutVerticalGroupBy.add(githubProjectHost(args.host))
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
  const projectFields: GitHubProjectField[] = []
  for (const f of project.fields?.nodes ?? []) {
    const n = normalizeField(f)
    if (n) {
      projectFields.push(n)
    }
  }
  const fieldsPi = project.fields?.pageInfo
  return {
    ok: true,
    project: { id: project.id, title: project.title ?? '', url: project.url ?? '' },
    projectFields,
    projectFieldsEndCursor:
      fieldsPi?.hasNextPage === true && typeof fieldsPi.endCursor === 'string'
        ? fieldsPi.endCursor
        : null,
    views,
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null
  }
}

export async function fetchFieldsContinuation(
  nodeId: string,
  after: string,
  host?: string
): Promise<
  { ok: true; fields: RawProjectV2Field[] } | { ok: false; error: GitHubProjectViewError }
> {
  // Why: address the view or project directly via node(id:) instead of re-walking all views each page — one round-trip per field page.
  const query = `
    query($after:String!, $nodeId:ID!) {
      node(id:$nodeId) {
        ... on ProjectV2View {
          id
          fields(first:${FIELDS_PAGE_SIZE}, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes { ...FieldConfig }
          }
        }
        ... on ProjectV2 {
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
    }>(query, { nodeId, after: cursor }, projectGhExecOptions(host))
    if (!res.ok) {
      return res
    }
    const node = res.data.node ?? null
    if (!node) {
      return { ok: false, error: driftError('node disappeared during field pagination') }
    }
    const nodes = (node.fields?.nodes ?? []).filter((f): f is RawProjectV2Field => f !== null)
    collected.push(...nodes)
    const pi = node.fields?.pageInfo
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
      // Preserve absence for older hosts and cached payloads.
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
