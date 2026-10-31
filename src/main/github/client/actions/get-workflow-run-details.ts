import { readActionsRelatedLinks } from './actions-related-links'
import type {
  ActionsDetailsQuery,
  ActionsRunDetails
} from '../../../../shared/github/actions-types'
import { ActionsDetailsQuery as DetailsSchema } from '../../../../shared/rpc-contract/github-actions-params'
import type { LocalGitExecOptions } from '../../gh-utils'
import { actionsJson, withActionsRead } from './actions-read-request'
import { actionsCount, actionsRecord, mapActionsRun } from './workflow-run-field-mapping'
import { mapWorkflowJobs } from '../check/check-detail-field-mapping'
import { attachFailedJobLogTails } from '../check/check-job-log-tails'
import { rethrowCheckDetailsAbort } from '../check/check-details-abort'

/** Read a selected or latest attempt’s jobs and bounded log excerpts; preserve run metadata when job reads fail. */
export function getWorkflowRunDetails(
  repoPath: string,
  query: ActionsDetailsQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  signal?: AbortSignal
): Promise<ActionsRunDetails> {
  const args = DetailsSchema.parse(query)
  return withActionsRead(
    repoPath,
    args.repository,
    connectionId,
    localGitOptions,
    signal,
    async (repository, options, context) => {
      const base = `repos/${repository.owner}/${repository.repo}/actions/runs/${args.runId}`
      const latestRaw = actionsRecord(await actionsJson(base, options))
      const latest = mapActionsRun(latestRaw)
      if (latest.id !== args.runId) {
        throw new Error('GitHub returned a different workflow run')
      }
      if (args.attempt && args.attempt > latest.runAttempt) {
        throw new Error('Workflow run attempt is not available')
      }
      const selectedRaw = args.attempt
        ? actionsRecord(await actionsJson(`${base}/attempts/${args.attempt}`, options))
        : latestRaw
      const run = mapActionsRun(selectedRaw)
      if (run.id !== args.runId || (args.attempt && run.runAttempt !== args.attempt)) {
        throw new Error('GitHub returned a different workflow run attempt')
      }
      const jobsPage =
        args.expectedAttempt && args.expectedAttempt !== run.runAttempt ? 1 : (args.jobsPage ?? 1)
      let jobs: ActionsRunDetails['jobs'] = []
      let totalJobs: number | null = null
      let jobsError: string | null = null
      const logWarnings: string[] = []
      const loadJobs = async (): Promise<void> => {
        try {
          const raw = actionsRecord(
            await actionsJson(
              `${base}/attempts/${run.runAttempt}/jobs?per_page=100&page=${jobsPage}`,
              options
            )
          )
          if (!Array.isArray(raw.jobs)) {
            throw new Error('Invalid GitHub Actions jobs page')
          }
          jobs = mapWorkflowJobs({ ...raw, jobs: raw.jobs.map(actionsRecord) })
          totalJobs = actionsCount(raw.total_count)
          await attachFailedJobLogTails(jobs, repository, options, context)
          logWarnings.push(...jobs.filter((job) => job.logState === 'error').map((job) => job.name))
        } catch (error) {
          rethrowCheckDetailsAbort(options.signal, error)
          jobsError = error instanceof Error ? error.message : String(error)
        }
      }
      const [links] = await Promise.all([
        jobsPage === 1
          ? readActionsRelatedLinks(selectedRaw, run, repository, options)
          : Promise.resolve({}),
        loadJobs()
      ])
      const more =
        !jobsError && (totalJobs === null ? jobs.length === 100 : jobsPage * 100 < totalJobs)
      return {
        name: run.displayTitle,
        status: run.status,
        conclusion: run.conclusion,
        url: run.htmlUrl,
        detailsUrl: run.htmlUrl,
        startedAt: run.runStartedAt,
        completedAt: null,
        title: null,
        summary: null,
        text: null,
        annotations: [],
        jobs,
        actions: {
          repository,
          run,
          latestAttempt: latest.runAttempt,
          ...links,
          jobsPage,
          totalJobs,
          jobsError,
          logWarnings,
          hasNextPage: more && jobsPage < 10,
          limitReached: more && jobsPage === 10
        }
      }
    }
  )
}
