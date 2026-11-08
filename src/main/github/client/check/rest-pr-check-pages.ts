import { z } from 'zod'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import { assertRateLimitBudget } from '../lookup/pr-lookup-rate-limit'
import { isPendingApprovalSuiteWithoutRuns } from './pr-checks-response-mapping'
import { PENDING_APPROVAL_ROLLUP_ROW } from './pr-check-rollup'

const checkRunSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullish(),
  details_url: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  check_suite: z.object({ id: z.number() }).nullish()
})
const commitStatusSchema = z.object({
  context: z.string().optional(),
  state: z.string(),
  target_url: z.string().nullish(),
  created_at: z.string().nullish()
})
const checkSuiteSchema = z.object({
  id: z.number().optional(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  app: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish()
})

async function readPages<T>(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  endpoint: string,
  field: string,
  row: z.ZodType<T>,
  noCache: boolean,
  pageLimit = Number.POSITIVE_INFINITY
): Promise<T[]> {
  const schema = z.looseObject({
    total_count: z.number().int().nonnegative()
  })
  const rows: T[] = []
  let total: number | undefined
  for (let page = 1; ; page++) {
    await assertRateLimitBudget('core', repository, options)
    const path = `repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(headSha)}/${endpoint}?per_page=100&page=${page}`
    const { stdout } = await ghExecFileAsync(
      ['api', ...(noCache ? [] : ['--cache', '60s']), path],
      { ...options, ...githubHostExecOptions(repository) }
    )
    noteRepositoryRateLimitSpend(repository, 'core', 1, options)
    const result = schema.parse(JSON.parse(stdout))
    const count = result.total_count
    const pageRows = z.array(row).parse(result[field])
    if (total !== undefined && total !== count) {
      throw new Error('PR checks changed during REST pagination')
    }
    total = count
    rows.push(...pageRows)
    if (rows.length > total || (pageRows.length === 0 && rows.length < total)) {
      throw new Error('Incomplete REST PR checks response')
    }
    if (rows.length === total) {
      return rows
    }
    if (page >= pageLimit) {
      throw new Error('Incomplete REST PR checks response')
    }
  }
}

export function readRestPRCheckRuns(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache = true,
  pageLimit?: number
) {
  return readPages(
    repository,
    headSha,
    options,
    'check-runs',
    'check_runs',
    checkRunSchema,
    noCache,
    pageLimit
  )
}

export function readRestPRCommitStatuses(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache = true,
  pageLimit?: number
) {
  return readPages(
    repository,
    headSha,
    options,
    'status',
    'statuses',
    commitStatusSchema,
    noCache,
    pageLimit
  )
}

export function readRestPRCheckSuites(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache = true,
  pageLimit?: number
) {
  return readPages(
    repository,
    headSha,
    options,
    'check-suites',
    'check_suites',
    checkSuiteSchema,
    noCache,
    pageLimit
  )
}

/** REST rows in the GraphQL rollup's field names, so both reads give a check the same identity. */
export function restPRCheckRollupRows(
  runs: readonly z.infer<typeof checkRunSchema>[],
  statuses: readonly z.infer<typeof commitStatusSchema>[],
  suites: readonly z.infer<typeof checkSuiteSchema>[]
): unknown[] {
  const representedSuites = new Set(
    runs.flatMap((run) => (run.check_suite ? [run.check_suite.id] : []))
  )
  return [
    ...runs.map((run) => ({
      __typename: 'CheckRun',
      name: run.name,
      databaseId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      ...(run.check_suite ? { checkSuite: { databaseId: run.check_suite.id } } : {})
    })),
    ...statuses.map((status) => ({
      ...status,
      __typename: 'StatusContext',
      targetUrl: status.target_url ?? null,
      createdAt: status.created_at ?? null
    })),
    ...suites
      .filter((suite) =>
        isPendingApprovalSuiteWithoutRuns(
          suite.conclusion,
          suite.id !== undefined && representedSuites.has(suite.id)
        )
      )
      .map(() => ({ ...PENDING_APPROVAL_ROLLUP_ROW }))
  ]
}

export async function readRestPRCheckRollup(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  pageLimit?: number
): Promise<unknown[]> {
  const runs = await readRestPRCheckRuns(repository, headSha, options, true, pageLimit)
  const statuses = await readRestPRCommitStatuses(repository, headSha, options, true, pageLimit)
  const suites = await readRestPRCheckSuites(repository, headSha, options, true, pageLimit)
  return restPRCheckRollupRows(runs, statuses, suites)
}
