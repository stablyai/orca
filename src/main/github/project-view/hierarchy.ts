// Why: Phase 2 — issue-level hierarchy reads are a separate, on-demand
// fetch triggered by opening the work-item drawer, not part of the
// paginated Project table fetch in ../project-view.ts (Phase 1b). Follows
// the internals.ts/mutations.ts split already established in this
// directory. See docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md.
import { assertPositiveInt, assertSlug, normalizeParentIssue, runGraphql } from './internals'
import type {
  GetIssueHierarchyArgs,
  GetIssueHierarchyResult,
  GitHubIssueHierarchyNode,
  GitHubProjectViewError
} from '../../../shared/github-project-types'

// Why: bounded page sizes keep a single drawer-open GraphQL call well under
// GitHub's node-cap/10s-timeout risk (see RFC §5.1/§5.4) — a "load more"
// affordance can page further later rather than eagerly fetching GitHub's
// full 100-children hard limit on open.
export const HIERARCHY_CHILDREN_PAGE_SIZE = 25
export const HIERARCHY_GRANDCHILDREN_PAGE_SIZE = 10

type RawParentIssue = { number?: number; title?: string; url?: string } | null | undefined

export type RawSubIssuesSummary =
  | { total?: number; completed?: number; percentCompleted?: number }
  | null
  | undefined

type RawHierarchyChildNode = {
  number?: number
  title?: string
  url?: string
  state?: string
  subIssuesSummary?: RawSubIssuesSummary
  subIssues?: { totalCount?: number; nodes?: (RawHierarchyChildNode | null | undefined)[] }
}

// Why: exported (test boundary, same pattern as project-view.ts's RawItem)
// so hierarchy.test.ts can construct hand-built fixtures.
export type RawHierarchyIssue = {
  parent?: RawParentIssue
  subIssuesSummary?: RawSubIssuesSummary
  subIssues?: { totalCount?: number; nodes?: (RawHierarchyChildNode | null | undefined)[] }
}

export function normalizeSummary(
  raw: RawSubIssuesSummary
): { total: number; completed: number; percentCompleted: number } | null {
  if (
    !raw ||
    typeof raw.total !== 'number' ||
    typeof raw.completed !== 'number' ||
    typeof raw.percentCompleted !== 'number'
  ) {
    return null
  }
  return { total: raw.total, completed: raw.completed, percentCompleted: raw.percentCompleted }
}

// Why: the grandchild level never fetches its own children — GitHub returns
// no `subIssues` field at that depth in our query — so this always produces
// `subIssues: []` for level-2 nodes. It's the same shape as a level-1 node
// so the rollup utility and renderer don't need a separate leaf type.
function normalizeChildNode(
  raw: RawHierarchyChildNode | null | undefined
): GitHubIssueHierarchyNode | null {
  if (
    !raw ||
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    typeof raw.url !== 'string' ||
    typeof raw.state !== 'string'
  ) {
    return null
  }
  const grandchildren = (raw.subIssues?.nodes ?? [])
    .map((n) => normalizeChildNode(n))
    .filter((n): n is GitHubIssueHierarchyNode => n !== null)
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    subIssuesSummary: normalizeSummary(raw.subIssuesSummary),
    subIssues: grandchildren
  }
}

// Why: pure normalizer separated from the network call (same discipline as
// project-view.ts's normalizeItem) — testable with hand-built fixtures, no
// `gh` mocking. Returns null when the raw issue itself is missing (upstream
// not_found), never throws on malformed nested data.
export function normalizeHierarchyResponse(
  raw: RawHierarchyIssue | null | undefined
): Omit<Extract<GetIssueHierarchyResult, { ok: true }>, 'ok'> | null {
  if (!raw) {
    return null
  }
  const childNodesRaw = raw.subIssues?.nodes ?? []
  // Why: keep raw/normalized pairs aligned so a dropped child can't shift later indices.
  const normalizedPairs = childNodesRaw
    .map((rawChild) => ({ rawChild, normalized: normalizeChildNode(rawChild) }))
    .filter(
      (p): p is { rawChild: RawHierarchyChildNode; normalized: GitHubIssueHierarchyNode } =>
        p.normalized !== null
    )
  const subIssues = normalizedPairs.map((p) => p.normalized)

  const childrenTotalCount = raw.subIssues?.totalCount ?? childNodesRaw.length
  const topLevelMore = childrenTotalCount > childNodesRaw.length
  const grandchildMore = normalizedPairs.some(({ rawChild, normalized: child }) => {
    const rawGrandchildTotal = rawChild?.subIssues?.totalCount ?? child.subIssues.length
    return rawGrandchildTotal > child.subIssues.length
  })

  return {
    parent: normalizeParentIssue(raw.parent),
    subIssuesSummary: normalizeSummary(raw.subIssuesSummary),
    subIssues,
    hasMoreChildren: topLevelMore || grandchildMore
  }
}

const GET_ISSUE_HIERARCHY_QUERY = `
query GetIssueHierarchy($owner: String!, $repo: String!, $number: Int!, $childrenFirst: Int!, $grandchildrenFirst: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      parent { number title url }
      subIssuesSummary { total completed percentCompleted }
      subIssues(first: $childrenFirst) {
        totalCount
        nodes {
          number
          title
          url
          state
          subIssuesSummary { total completed percentCompleted }
          subIssues(first: $grandchildrenFirst) {
            totalCount
            nodes {
              number
              title
              url
              state
              subIssuesSummary { total completed percentCompleted }
            }
          }
        }
      }
    }
  }
}
`

type GetIssueHierarchyGraphqlResponse = {
  repository: { issue: RawHierarchyIssue | null } | null
}

export async function getIssueHierarchy(
  args: GetIssueHierarchyArgs
): Promise<GetIssueHierarchyResult> {
  const owner = assertSlug(args.owner, 'owner')
  if (!owner.ok) {
    return { ok: false, error: owner.error }
  }
  const repo = assertSlug(args.repo, 'repo')
  if (!repo.ok) {
    return { ok: false, error: repo.error }
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }

  const res = await runGraphql<GetIssueHierarchyGraphqlResponse>(GET_ISSUE_HIERARCHY_QUERY, {
    owner: owner.slug,
    repo: repo.slug,
    number: number.n,
    childrenFirst: HIERARCHY_CHILDREN_PAGE_SIZE,
    grandchildrenFirst: HIERARCHY_GRANDCHILDREN_PAGE_SIZE
  })
  if (!res.ok) {
    return { ok: false, error: res.error }
  }

  const rawIssue = res.data.repository?.issue
  const normalized = normalizeHierarchyResponse(rawIssue)
  if (!normalized) {
    return { ok: false, error: { type: 'not_found', message: 'Issue not found.' } }
  }
  return { ok: true, ...normalized }
}

// ─── Mutation argument validation (pure, no network) ───────────────────
// Why: cheap client-side guards before spending a GraphQL round trip —
// self-reference and slug shape are checkable without any fetch. GitHub's
// own hard limits (100 children/issue, 8 levels deep) are NOT pre-validated
// anywhere client-side — both limit violations are relayed via GitHub's own
// error message through the existing classifyProjectError path in
// hierarchy-mutations.ts's write-path functions (documented limitation,
// see plan §Open questions).

type SlugArgs = { owner: unknown; repo: unknown; number: unknown; subIssueNumber: unknown }

function validateSlugAndNumbers(
  args: SlugArgs
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  const owner = assertSlug(args.owner, 'owner')
  if (!owner.ok) {
    return owner
  }
  const repo = assertSlug(args.repo, 'repo')
  if (!repo.ok) {
    return repo
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return number
  }
  const subIssueNumber = assertPositiveInt(args.subIssueNumber, 'subIssueNumber')
  if (!subIssueNumber.ok) {
    return subIssueNumber
  }
  if (number.n === subIssueNumber.n) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'An issue cannot be its own sub-issue.' }
    }
  }
  return { ok: true }
}

export function validateAddSubIssueArgs(
  args: SlugArgs
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  return validateSlugAndNumbers(args)
}

export function validateRemoveSubIssueArgs(
  args: SlugArgs
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  return validateSlugAndNumbers(args)
}

export function validateReprioritizeSubIssueArgs(
  args: SlugArgs & { beforeNumber?: unknown; afterNumber?: unknown }
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  const base = validateSlugAndNumbers(args)
  if (!base.ok) {
    return base
  }
  if (args.beforeNumber !== undefined && args.afterNumber !== undefined) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Provide at most one of beforeNumber/afterNumber, not both.'
      }
    }
  }
  if (args.beforeNumber !== undefined && args.beforeNumber === args.subIssueNumber) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'A sub-issue cannot be reordered before itself.' }
    }
  }
  if (args.afterNumber !== undefined && args.afterNumber === args.subIssueNumber) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'A sub-issue cannot be reordered after itself.' }
    }
  }
  return { ok: true }
}
