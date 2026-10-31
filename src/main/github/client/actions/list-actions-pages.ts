import type {
  ActionsPage,
  ActionsRun,
  ActionsWorkflow,
  ActionsRunsQuery,
  ActionsWorkflowsQuery
} from '../../../../shared/github/actions-types'
import {
  ACTIONS_RUNS_MAX_PAGE,
  ACTIONS_RUNS_PER_PAGE
} from '../../../../shared/github/actions-types'
import {
  ActionsRunsQuery as RunsSchema,
  ActionsWorkflowsQuery as WorkflowsSchema
} from '../../../../shared/rpc-contract/github-actions-params'
import type { LocalGitExecOptions } from '../../gh-utils'
import { actionsJson, withActionsRead } from './actions-read-request'
import {
  actionsRecord,
  actionsCount,
  mapActionsRun,
  mapActionsWorkflow
} from './workflow-run-field-mapping'

/** Read a filtered run page on the resolved GitHub execution route, stopping at the supported page ceiling. */
export function listActionsRuns(
  repoPath: string,
  query: ActionsRunsQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  signal?: AbortSignal
): Promise<ActionsPage<ActionsRun>> {
  const args = RunsSchema.parse(query)
  const page = args.page ?? 1
  return withActionsRead(
    repoPath,
    undefined,
    connectionId,
    localGitOptions,
    signal,
    async (repository, options) => {
      const filters = new URLSearchParams({
        per_page: String(ACTIONS_RUNS_PER_PAGE),
        page: String(page)
      })
      if (args.branch) {
        filters.set('branch', args.branch)
      }
      if (args.status) {
        filters.set('status', args.status)
      }
      const base = `repos/${repository.owner}/${repository.repo}/actions`
      const path = args.workflowId ? `${base}/workflows/${args.workflowId}/runs` : `${base}/runs`
      const raw = actionsRecord(await actionsJson(`${path}?${filters}`, options))
      if (!Array.isArray(raw.workflow_runs)) {
        throw new Error('Invalid GitHub Actions run page')
      }
      const items = raw.workflow_runs.map(mapActionsRun)
      const totalCount = actionsCount(raw.total_count)
      const more =
        totalCount === null
          ? items.length === ACTIONS_RUNS_PER_PAGE
          : page * ACTIONS_RUNS_PER_PAGE < totalCount
      return {
        repository,
        items,
        page,
        perPage: ACTIONS_RUNS_PER_PAGE,
        totalCount,
        hasNextPage: more && page < ACTIONS_RUNS_MAX_PAGE,
        limitReached: more && page === ACTIONS_RUNS_MAX_PAGE
      }
    }
  )
}
/** Read one workflow page and report truncation when GitHub has more data beyond the ten-page ceiling. */
export function listActionsWorkflows(
  repoPath: string,
  query: ActionsWorkflowsQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  signal?: AbortSignal
): Promise<ActionsPage<ActionsWorkflow>> {
  const args = WorkflowsSchema.parse(query)
  const page = args.page ?? 1
  return withActionsRead(
    repoPath,
    undefined,
    connectionId,
    localGitOptions,
    signal,
    async (repository, options) => {
      const raw = actionsRecord(
        await actionsJson(
          `repos/${repository.owner}/${repository.repo}/actions/workflows?per_page=100&page=${page}`,
          options
        )
      )
      if (!Array.isArray(raw.workflows)) {
        throw new Error('Invalid GitHub Actions workflow page')
      }
      const items = raw.workflows.map(mapActionsWorkflow)
      const totalCount = actionsCount(raw.total_count)
      const more = totalCount === null ? items.length === 100 : page * 100 < totalCount
      return {
        repository,
        items,
        page,
        perPage: 100,
        totalCount,
        hasNextPage: more && page < 10,
        limitReached: more && page === 10
      }
    }
  )
}
