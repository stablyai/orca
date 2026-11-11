import { z } from 'zod'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import { isPendingApprovalSuiteWithoutRuns } from './pr-checks-response-mapping'

type ConnectionKind = 'contexts' | 'suites'

/** Pages per connection for CI-line reads; a longer read is incomplete and decides nothing.
 *  Other callers read every page. */
export const PR_CHECK_PAGE_LIMIT = 10

/** A suite waiting for approval reads as a blocker, tagged so it is never taken for a real check. */
export const PENDING_APPROVAL_ROLLUP_ROW = {
  status: 'COMPLETED',
  conclusion: 'ACTION_REQUIRED',
  pendingApproval: true
} as const

export function prCheckRollupFields(kind?: ConnectionKind): string {
  return `commits(last: 1) { nodes { commit {
    oid
    ${
      kind !== 'suites'
        ? `statusCheckRollup { contexts(first: 100, after: $checksCursor) {
      nodes { __typename ... on CheckRun { name databaseId status conclusion checkSuite { databaseId } }
        ... on StatusContext { context state targetUrl createdAt } }
      pageInfo { hasNextPage endCursor }
    } }`
        : ''
    }
    ${
      kind !== 'contexts'
        ? `checkSuites(first: 100, after: $suitesCursor) {
      nodes { databaseId conclusion }
      pageInfo { hasNextPage endCursor }
    }`
        : ''
    }
  } } }`
}

const checkConclusion = z.enum([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'NEUTRAL',
  'SKIPPED',
  'STALE',
  'STARTUP_FAILURE',
  'SUCCESS',
  'TIMED_OUT'
])
const contextSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string().optional(),
    databaseId: z.number().nullish(),
    status: z.enum(['COMPLETED', 'IN_PROGRESS', 'QUEUED', 'REQUESTED', 'WAITING', 'PENDING']),
    conclusion: checkConclusion.nullable(),
    checkSuite: z.object({ databaseId: z.number() })
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string().optional(),
    state: z.enum(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']),
    targetUrl: z.string().nullish(),
    createdAt: z.string().nullish()
  })
])
const connectionSchema = z.object({
  nodes: z.array(contextSchema),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
})

export const prCheckRollupCommitsSchema = z.object({
  nodes: z
    .array(
      z.object({
        commit: z.object({
          oid: z.string().min(1),
          statusCheckRollup: z.object({ contexts: connectionSchema }).nullable().optional(),
          checkSuites: z
            .object({
              nodes: z.array(
                z.object({ databaseId: z.number(), conclusion: checkConclusion.nullable() })
              ),
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
            })
            .optional()
        })
      })
    )
    .max(1)
})

type CheckCommits = z.infer<typeof prCheckRollupCommitsSchema>
type CheckPage = { number: number; headRefOid: string; commits: CheckCommits }
const pageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        number: z.number(),
        headRefOid: z.string(),
        commits: prCheckRollupCommitsSchema
      })
    })
  }),
  errors: z.array(z.unknown()).optional()
})

export async function collectPRCheckRollup(
  first: CheckPage,
  readPage: (kind: ConnectionKind, cursor: string) => Promise<CheckPage>,
  pageLimit = Number.POSITIVE_INFINITY
): Promise<unknown[]> {
  const initial = first.commits.nodes[0]?.commit
  if (
    !initial ||
    initial.oid !== first.headRefOid ||
    !initial.checkSuites ||
    initial.statusCheckRollup === undefined
  ) {
    throw new Error('Incomplete PR checks observation')
  }
  const collect = async (kind: ConnectionKind) => {
    const connection = (commit: typeof initial) =>
      kind === 'contexts' ? commit.statusCheckRollup?.contexts : commit.checkSuites
    let page = connection(initial)
    const nodes: Record<string, unknown>[] = [...(page?.nodes ?? [])]
    const cursors = new Set<string>()
    while (page?.pageInfo.hasNextPage) {
      const cursor = page.pageInfo.endCursor
      if (!cursor || cursors.has(cursor) || cursors.size + 1 >= pageLimit) {
        throw new Error('Incomplete PR checks continuation')
      }
      cursors.add(cursor)
      const next = await readPage(kind, cursor)
      const commit = next.commits.nodes[0]?.commit
      if (
        next.number !== first.number ||
        next.headRefOid !== first.headRefOid ||
        !commit ||
        commit.oid !== initial.oid
      ) {
        throw new Error('PR head changed during checks observation')
      }
      page = connection(commit)
      if (!page) {
        throw new Error('Missing PR checks continuation')
      }
      nodes.push(...page.nodes)
    }
    return nodes
  }
  const contexts = await collect('contexts')
  const suites = await collect('suites')
  const representedSuites = new Set(
    contexts.flatMap((context) => {
      const suite = context.checkSuite
      return context.__typename === 'CheckRun' &&
        typeof suite === 'object' &&
        suite !== null &&
        'databaseId' in suite &&
        typeof suite.databaseId === 'number'
        ? [suite.databaseId]
        : []
    })
  )
  return [
    ...contexts,
    ...suites
      .filter((suite) =>
        isPendingApprovalSuiteWithoutRuns(
          suite.conclusion,
          typeof suite.databaseId === 'number' && representedSuites.has(suite.databaseId)
        )
      )
      .map(() => ({ ...PENDING_APPROVAL_ROLLUP_ROW }))
  ]
}

export function createPRCheckRollupPageReader(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions
): (kind?: ConnectionKind, cursor?: string) => Promise<CheckPage> {
  return async (kind, cursor) => {
    const cursors = [
      ...(kind !== 'suites' ? ['$checksCursor: String'] : []),
      ...(kind !== 'contexts' ? ['$suitesCursor: String'] : [])
    ].join(', ')
    const query = `query($owner: String!, $repo: String!, $number: Int!,
      ${cursors}) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
        number headRefOid ${prCheckRollupFields(kind)}
      } }
    }`
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${repository.owner}`,
      '-f',
      `repo=${repository.repo}`,
      '-F',
      `number=${number}`
    ]
    if (cursor) {
      args.push('-f', `${kind === 'suites' ? 'suitesCursor' : 'checksCursor'}=${cursor}`)
    }
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, options)
    const { stdout } = await ghExecFileAsync(args, {
      ...options,
      ...githubHostExecOptions(repository)
    })
    const page = pageSchema.parse(JSON.parse(stdout))
    if (page.errors?.length) {
      throw new Error('Incomplete PR checks response')
    }
    return page.data.repository.pullRequest
  }
}

export async function readGraphQLPRCheckRollup(
  repository: GitHubApiRepository,
  number: number,
  headSha: string,
  options: GhExecOptions,
  pageLimit?: number
): Promise<unknown[]> {
  const readPage = createPRCheckRollupPageReader(repository, number, options)
  const first = await readPage()
  if (first.number !== number || first.headRefOid !== headSha) {
    throw new Error('PR head changed before checks observation')
  }
  return collectPRCheckRollup(first, readPage, pageLimit)
}
