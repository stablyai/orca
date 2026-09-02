import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import {
  acquire,
  extractExecError,
  ghExecFileAsync,
  noteRepositoryRateLimitSpend,
  projectGhExecOptions,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard
} from './internals'
import {
  classifyProjectError,
  driftError,
  rateLimitedError,
  type GhGraphqlErrorShape
} from './project-error-classification'
import { ownerQueryRoot } from './project-view-config'
import type { RawItem } from './project-view-item-normalization'
import {
  FIELD_CONFIG_FRAGMENT,
  FIELD_VALUES_SELECTION,
  itemContentSelection
} from './project-view-query-fragments'

// ─── Items fetch (paginated) ──────────────────────────────────────────

export type RawItemsPage = {
  totalCount?: number
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  nodes?: (RawItem | null)[]
}

// Why: unlike runGraphql, return the raw GraphQL error envelope so the parent-field retry decision can re-inspect it.
export async function fetchItemsPageWithRaw(args: {
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
