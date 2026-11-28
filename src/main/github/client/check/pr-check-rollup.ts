import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
import type { GhExecOptions } from '../github-exec-scope'

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

export function isPendingApprovalSuiteWithoutRuns(conclusion: unknown, hasRuns: boolean): boolean {
  return (
    typeof conclusion === 'string' && conclusion.toLowerCase() === 'action_required' && !hasRuns
  )
}

export function prCheckRollupFields(kind?: ConnectionKind, detailed = false): string {
  return `commits(last: 1) { nodes { commit {
    oid
    ${
      kind !== 'suites'
        ? `statusCheckRollup { contexts(first: 100, after: $checksCursor) {
      nodes { __typename ... on CheckRun {
        name databaseId status conclusion
        ${detailed ? 'detailsUrl url startedAt completedAt' : ''}
        checkSuite { databaseId ${detailed ? 'workflowRun { databaseId }' : ''} }
      }
        ... on StatusContext { context state targetUrl createdAt } }
      pageInfo { hasNextPage endCursor }
    } }`
        : ''
    }
    ${
      kind !== 'contexts'
        ? `checkSuites(first: 100, after: $suitesCursor) {
      nodes { databaseId conclusion ${detailed ? 'url app { name slug }' : ''} }
      pageInfo { hasNextPage endCursor }
    }`
        : ''
    }
  } } }`
}

const checkConclusion = lazyZodSchema(() =>
  z.enum([
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
)
const contextSchema = lazyZodSchema(() =>
  z.discriminatedUnion('__typename', [
    z.object({
      __typename: z.literal('CheckRun'),
      name: z.string().optional(),
      databaseId: z.number().nullish(),
      status: z.enum(['COMPLETED', 'IN_PROGRESS', 'QUEUED', 'REQUESTED', 'WAITING', 'PENDING']),
      conclusion: checkConclusion.nullable(),
      detailsUrl: z.string().nullish(),
      url: z.string().nullish(),
      startedAt: z.string().nullish(),
      completedAt: z.string().nullish(),
      checkSuite: z.object({
        databaseId: z.number(),
        workflowRun: z.object({ databaseId: z.number().nullish() }).nullish()
      })
    }),
    z.object({
      __typename: z.literal('StatusContext'),
      context: z.string().optional(),
      state: z.enum(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']),
      targetUrl: z.string().nullish(),
      createdAt: z.string().nullish()
    })
  ])
)
const pageInfoSchema = lazyZodSchema(() =>
  z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
)
const suiteSchema = lazyZodSchema(() =>
  z.object({
    databaseId: z.number(),
    conclusion: checkConclusion.nullable(),
    url: z.string().nullish(),
    app: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish()
  })
)

export const prCheckRollupCommitsSchema = lazyZodSchema(() =>
  z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string().min(1),
            statusCheckRollup: z
              .object({
                contexts: z.object({ nodes: z.array(contextSchema), pageInfo: pageInfoSchema })
              })
              .nullable()
              .optional(),
            checkSuites: z
              .object({
                nodes: z.array(suiteSchema),
                pageInfo: pageInfoSchema
              })
              .optional()
          })
        })
      )
      .max(1)
  })
)

type CheckCommits = z.infer<typeof prCheckRollupCommitsSchema>
type CheckCommit = CheckCommits['nodes'][number]['commit']
export type PRCheckContext = z.infer<typeof contextSchema>
export type PRCheckSuite = z.infer<typeof suiteSchema>
export type PRCheckPages = {
  headSha: string
  contexts: PRCheckContext[]
  suites: PRCheckSuite[]
}
type CheckPage = { number: number; headRefOid: string; commits: CheckCommits }
const pageSchema = lazyZodSchema(() =>
  z.object({
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
)

async function collectPRCheckPages(
  first: CheckPage,
  readPage: (kind: ConnectionKind, cursor: string) => Promise<CheckPage>,
  pageLimit = Number.POSITIVE_INFINITY
): Promise<PRCheckPages> {
  const initial = first.commits.nodes[0]?.commit
  if (
    !initial ||
    initial.oid !== first.headRefOid ||
    !initial.checkSuites ||
    initial.statusCheckRollup === undefined
  ) {
    throw new Error('Incomplete PR checks observation')
  }
  const collect = async <T>(
    kind: ConnectionKind,
    connection: (
      commit: CheckCommit
    ) => { nodes: T[]; pageInfo: z.infer<typeof pageInfoSchema> } | undefined
  ): Promise<T[]> => {
    let page = connection(initial)
    const nodes = [...(page?.nodes ?? [])]
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
  const contexts = await collect('contexts', (commit) => commit.statusCheckRollup?.contexts)
  const suites = await collect('suites', (commit) => commit.checkSuites)
  return { headSha: initial.oid, contexts, suites }
}

export function prCheckRollupRows({ contexts, suites }: PRCheckPages): unknown[] {
  const representedSuites = new Set(
    contexts.flatMap((context) =>
      context.__typename === 'CheckRun' ? [context.checkSuite.databaseId] : []
    )
  )
  return [
    ...contexts,
    ...suites
      .filter((suite) =>
        isPendingApprovalSuiteWithoutRuns(suite.conclusion, representedSuites.has(suite.databaseId))
      )
      .map(() => ({ ...PENDING_APPROVAL_ROLLUP_ROW }))
  ]
}

export async function collectPRCheckRollup(
  first: CheckPage,
  readPage: (kind: ConnectionKind, cursor: string) => Promise<CheckPage>,
  pageLimit?: number
): Promise<unknown[]> {
  return prCheckRollupRows(await collectPRCheckPages(first, readPage, pageLimit))
}

export function createPRCheckRollupPageReader(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  detailed = false
): (kind?: ConnectionKind, cursor?: string) => Promise<CheckPage> {
  return async (kind, cursor) => {
    const cursors = [
      ...(kind !== 'suites' ? ['$checksCursor: String'] : []),
      ...(kind !== 'contexts' ? ['$suitesCursor: String'] : [])
    ].join(', ')
    const query = `query($owner: String!, $repo: String!, $number: Int!,
      ${cursors}) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
        number headRefOid ${prCheckRollupFields(kind, detailed)}
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
  return prCheckRollupRows(
    await readGraphQLPRCheckPages(repository, number, options, { headSha, pageLimit })
  )
}

export async function readGraphQLPRCheckPages(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  {
    detailed,
    headSha,
    pageLimit
  }: { detailed?: boolean; headSha?: string; pageLimit?: number } = {}
): Promise<PRCheckPages> {
  const readPage = createPRCheckRollupPageReader(repository, number, options, detailed)
  const first = await readPage()
  if (first.number !== number || (headSha !== undefined && first.headRefOid !== headSha)) {
    throw new Error('PR head changed before checks observation')
  }
  return collectPRCheckPages(first, readPage, pageLimit)
}
