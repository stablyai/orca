import { z } from 'zod'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { checkRunTimes } from '../../../../shared/source-control/checks/pr-check-time'
import { extractExecError } from '../../../git/exec-error'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { mapCheckRunRESTConclusion } from '../../mappers'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import { assertRateLimitBudget } from '../lookup/pr-lookup-rate-limit'

// Why: a fine-grained personal access token cannot be granted the Checks permission, so
// GitHub refuses every check-run read with this message while Actions reads still work.
export function isCheckRunsPermissionDenied(err: unknown): boolean {
  const { stderr, stdout } = extractExecError(err)
  const message = `${stderr}\n${stdout}\n${err instanceof Error ? err.message : ''}`
  return message.toLowerCase().includes('resource not accessible by personal access token')
}

const workflowRunSchema = z.object({ id: z.number() })
const jobSchema = z.object({
  id: z.number().optional(),
  run_id: z.number().optional(),
  name: z.string().nullish(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish()
})

async function readActionsPages<T>(
  repository: GitHubApiRepository,
  options: GhExecOptions,
  path: string,
  field: string,
  row: z.ZodType<T>,
  noCache: boolean
): Promise<T[]> {
  const schema = z.looseObject({ total_count: z.number().int().nonnegative() })
  const rows: T[] = []
  for (let page = 1; ; page++) {
    await assertRateLimitBudget('core', repository, options)
    const separator = path.includes('?') ? '&' : '?'
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        ...(noCache ? [] : ['--cache', '60s']),
        `repos/${repository.owner}/${repository.repo}/${path}${separator}per_page=100&page=${page}`
      ],
      { ...options, ...githubHostExecOptions(repository) }
    )
    noteRepositoryRateLimitSpend(repository, 'core', 1, options)
    const result = schema.parse(JSON.parse(stdout))
    const pageRows = z.array(row).parse(result[field])
    rows.push(...pageRows)
    if (pageRows.length === 0 || rows.length >= result.total_count) {
      return rows
    }
  }
}

function mapActionsJobStatus(status: string): PRCheckDetail['status'] {
  const s = status.toLowerCase()
  if (s === 'in_progress') {
    return 'in_progress'
  }
  // Jobs also report waiting, pending and requested, which are all not started yet.
  return s === 'completed' ? 'completed' : 'queued'
}

/** The head commit's GitHub Actions jobs as check rows. A job's id is its check run's id. */
export async function readActionsJobChecks(
  repository: GitHubApiRepository,
  headSha: string,
  options: GhExecOptions,
  noCache: boolean
): Promise<PRCheckDetail[]> {
  const runs = await readActionsPages(
    repository,
    options,
    `actions/runs?head_sha=${encodeURIComponent(headSha)}`,
    'workflow_runs',
    workflowRunSchema,
    noCache
  )
  const checks: PRCheckDetail[] = []
  for (const run of runs) {
    const jobs = await readActionsPages(
      repository,
      options,
      `actions/runs/${run.id}/jobs?filter=latest`,
      'jobs',
      jobSchema,
      noCache
    )
    for (const job of jobs) {
      if (!job.name) {
        continue
      }
      const status = mapActionsJobStatus(job.status)
      checks.push({
        name: job.name,
        status,
        conclusion: mapCheckRunRESTConclusion(status, job.conclusion),
        url: job.html_url || null,
        ...checkRunTimes(job.started_at, job.completed_at),
        ...(job.id !== undefined ? { checkRunId: job.id } : {}),
        workflowRunId: job.run_id ?? run.id
      })
    }
  }
  return checks
}
