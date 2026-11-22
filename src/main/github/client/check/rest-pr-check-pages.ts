import { z } from 'zod'
import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
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
const workflowRunSchema = z.object({
  id: z.number(),
  check_suite_id: z.number().nullish(),
  status: z.string().nullable(),
  conclusion: z.string().nullable()
})
const checkSuiteSchema = z.object({
  id: z.number().optional(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  app: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish()
})

async function readPages<T>(
  repository: GitHubApiRepository,
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
    const separator = endpoint.includes('?') ? '&' : '?'
    const path = `repos/${repository.owner}/${repository.repo}/${endpoint}${separator}per_page=100&page=${page}`
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

function commitEndpoint(headSha: string, endpoint: string): string {
  return `commits/${encodeURIComponent(headSha)}/${endpoint}`
}

// Why: fine-grained tokens cannot be granted the Checks permission, but can read Actions.
export function isCheckRunsPermissionDenied(err: unknown): boolean {
  const { stderr, stdout } = extractExecError(err)
  const message = `${stderr}\n${stdout}\n${err instanceof Error ? err.message : ''}`
  return message.toLowerCase().includes('resource not accessible by personal access token')
}

function readHeadWorkflowRuns(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache: boolean,
  pageLimit?: number
) {
  return readPages(
    repository,
    options,
    `actions/runs?head_sha=${encodeURIComponent(headSha)}`,
    'workflow_runs',
    workflowRunSchema,
    noCache,
    pageLimit
  )
}

/** The head commit's Actions jobs as check runs; a job's id is its check run's id. */
async function readActionsJobsAsCheckRuns(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache: boolean,
  pageLimit?: number
): Promise<z.infer<typeof checkRunSchema>[]> {
  const runs = await readHeadWorkflowRuns(repository, headSha, options, noCache, pageLimit)
  const checkRuns: z.infer<typeof checkRunSchema>[] = []
  for (const run of runs) {
    const jobs = await readPages(
      repository,
      options,
      `actions/runs/${run.id}/jobs?filter=latest`,
      'jobs',
      checkRunSchema,
      noCache,
      pageLimit
    )
    for (const job of jobs) {
      checkRuns.push({
        ...job,
        details_url: job.html_url,
        check_suite: run.check_suite_id ? { id: run.check_suite_id } : null
      })
    }
  }
  return checkRuns
}

export async function readRestPRCheckRuns(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache = true,
  pageLimit?: number
) {
  try {
    return await readPages(
      repository,
      options,
      commitEndpoint(headSha, 'check-runs'),
      'check_runs',
      checkRunSchema,
      noCache,
      pageLimit
    )
  } catch (err) {
    if (!isCheckRunsPermissionDenied(err)) {
      throw err
    }
    return readActionsJobsAsCheckRuns(repository, headSha, options, noCache, pageLimit)
  }
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
    options,
    commitEndpoint(headSha, 'status'),
    'statuses',
    commitStatusSchema,
    noCache,
    pageLimit
  )
}

export async function readRestPRCheckSuites(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache = true,
  pageLimit?: number
): Promise<z.infer<typeof checkSuiteSchema>[]> {
  try {
    return await readPages(
      repository,
      options,
      commitEndpoint(headSha, 'check-suites'),
      'check_suites',
      checkSuiteSchema,
      noCache,
      pageLimit
    )
  } catch (err) {
    if (!isCheckRunsPermissionDenied(err)) {
      throw err
    }
    // Each workflow run is its own check suite, so approval blockers still surface.
    const runs = await readHeadWorkflowRuns(repository, headSha, options, noCache, pageLimit)
    return runs.map((run) => ({
      id: run.check_suite_id ?? undefined,
      status: run.status,
      conclusion: run.conclusion,
      app: { name: 'GitHub Actions' }
    }))
  }
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
