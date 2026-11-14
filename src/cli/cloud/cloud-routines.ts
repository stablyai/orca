// Private build only: `orca cloud routine list|run`. Routines live on the control plane
// (GET /v1/routines, POST /v1/routines/:id/run, GET /v1/routines/:id/runs/:runId); each run starts
// its own cloud workspace. Human output uses the glossary's run states; --json prints the API view.
import type { CommandHandler } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import type {
  Routine,
  RoutineRun,
  RoutineRunStatus
} from '../../shared/cloud-api/cloud-api-routine-types'
import { formatAutomationSchedule } from '../../shared/automations/scheduling/automation-schedules'
import {
  ROUTINE_RUN_CLAUDE_NOT_SET_UP,
  isRoutineRunAgentSignInFailure
} from '../../shared/cloud-api/routine-run-sign-in'
import type { CloudApiClient } from './cloud-api-client'
import { ago, formatElapsed, printCloudResult, table } from './cloud-format'
import { cloudClient, type CloudHandlerDeps } from './cloud-operations'
import { cloudProgress, readCloudProgressMode } from './cloud-progress'

const ROUTINE_ID = /^rtn_[A-Za-z0-9_-]+$/
const RUN_POLL_MS = 5000
/** --wait without --timeout: the routine's own time limit plus room to start and post results. */
const WAIT_SLACK_MS = 15 * 60_000
const DEFAULT_RUNTIME_MINUTES = 60

const RUN_STATE_LABELS: ReadonlyMap<string, string> = new Map<RoutineRunStatus, string>([
  ['queued', 'Queued'],
  ['starting', 'Starting'],
  ['running', 'Running'],
  ['posting', 'Posting results'],
  ['succeeded', 'Succeeded'],
  ['failed', 'Failed'],
  ['cancelled', 'Canceled'],
  ['timed_out', 'Timed out']
])

const FINISHED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

export function routineRunStateLabel(status: string): string {
  return RUN_STATE_LABELS.get(status) ?? 'Unknown'
}

/** A failed run's error code in words (codes stay in --json). */
export function routineRunErrorCopy(error: string | null, summary?: string | null): string {
  const code = error ?? ''
  if (isRoutineRunAgentSignInFailure(error, summary)) {
    return ROUTINE_RUN_CLAUDE_NOT_SET_UP
  }
  if (code.startsWith('start_failed')) {
    return "The workspace couldn't start. Nothing was charged."
  }
  if (code.startsWith('workspace_lost')) {
    return 'The workspace went to sleep or was deleted before the run finished.'
  }
  if (code.startsWith('post_failed')) {
    return "The run finished, but Orca couldn't post the results."
  }
  if (code === 'queue_expired') {
    return 'The run waited too long to start and was skipped.'
  }
  if (code.endsWith('_interrupted')) {
    return 'Orca Cloud restarted during the run.'
  }
  if (code === 'routine_changed') {
    return 'The routine changed while this run was queued.'
  }
  return 'The run failed.'
}

function describeTrigger(trigger: Routine['trigger']): string {
  if (trigger.kind === 'schedule') {
    return `${formatAutomationSchedule(trigger.cron)} (${trigger.timezone})`
  }
  if (trigger.kind === 'webhook') {
    return 'Webhook'
  }
  return 'GitHub'
}

export function formatRoutineList(value: { routines: Routine[] }, now = Date.now()): string {
  if (value.routines.length === 0) {
    return 'No routines yet. Create one in the Orca app.'
  }
  return table(
    ['ID', 'NAME', 'WHEN', 'LAST RUN'],
    value.routines.map((r) => [
      r.id,
      r.enabled ? r.name : `${r.name} (paused)`,
      describeTrigger(r.trigger),
      r.lastRun
        ? `${routineRunStateLabel(r.lastRun.status)}${r.lastRun.finishedAt ? ` ${ago(r.lastRun.finishedAt, now)}` : ''}`
        : 'Never run'
    ])
  )
}

export function formatRoutineRun(value: {
  routine: Pick<Routine, 'name'>
  run: RoutineRun
}): string {
  const { run } = value
  const lines = [
    `${value.routine.name}: ${routineRunStateLabel(run.status)} (${run.id})`,
    ...(run.status === 'failed' ? [routineRunErrorCopy(run.error, run.result?.summary)] : []),
    ...(run.status === 'timed_out' ? ['The run hit its time limit.'] : []),
    ...(run.durationMs !== null ? [`Took ${formatElapsed(run.durationMs)}`] : []),
    ...(run.result?.prUrl ? [`Pull request: ${run.result.prUrl}`] : []),
    ...(run.result?.commentUrl ? [`Comment: ${run.result.commentUrl}`] : []),
    ...(run.workspaceId ? [`Workspace: ${run.workspaceId}`] : []),
    // Claude's raw "Please run /login" is replaced by the line above, not repeated.
    ...(run.result?.summary && !isRoutineRunAgentSignInFailure(run.error, run.result.summary)
      ? ['', run.result.summary]
      : [])
  ]
  if (!FINISHED.has(run.status)) {
    lines.push('Add --wait to follow a run until it finishes.')
  }
  return lines.join('\n')
}

async function resolveRoutine(api: CloudApiClient, selector: string): Promise<Routine> {
  if (ROUTINE_ID.test(selector)) {
    return (
      await api.request<{ routine: Routine }>('GET', `/v1/routines/${encodeURIComponent(selector)}`)
    ).routine
  }
  const { routines } = await api.request<{ routines: Routine[] }>('GET', '/v1/routines')
  const matches = routines.filter((r) => r.name === selector)
  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length === 0) {
    throw new RuntimeClientError('cloud_not_found', `No routine named "${selector}".`, {
      nextSteps: ['Run `orca cloud routine list` and pass the routine id (rtn_…).']
    })
  }
  throw new RuntimeClientError(
    'selector_ambiguous',
    `${matches.length} routines are named "${selector}". Pass the id instead.`,
    { choices: matches.map((r) => ({ id: r.id, name: r.name })) }
  )
}

function runFinishedError(routine: Routine, run: RoutineRun): RuntimeClientError | null {
  if (run.status === 'failed') {
    return new RuntimeClientError(
      'cloud_routine_run_failed',
      routineRunErrorCopy(run.error, run.result?.summary),
      {
        run
      }
    )
  }
  if (run.status === 'timed_out') {
    return new RuntimeClientError(
      'cloud_routine_run_timed_out',
      `The run hit ${routine.name}'s time limit.`,
      { run }
    )
  }
  if (run.status === 'cancelled') {
    return new RuntimeClientError('cloud_routine_run_canceled', 'The run was canceled.', { run })
  }
  return null
}

export function createCloudRoutineHandlers(
  getDeps: () => CloudHandlerDeps
): Record<string, CommandHandler> {
  return {
    'cloud routine list': async ({ json }) => {
      const deps = getDeps()
      const api = cloudClient(deps)
      const result = await api.request<{ routines: Routine[] }>('GET', '/v1/routines')
      printCloudResult(result, json, (value) => formatRoutineList(value, deps.now()))
    },
    'cloud routine run': async ({ flags, json }) => {
      const deps = getDeps()
      const wait = flags.get('wait') === true
      const timeoutSeconds = getOptionalPositiveIntegerFlag(flags, 'timeout')
      if (timeoutSeconds !== undefined && !wait) {
        throw new RuntimeClientError('invalid_argument', '--timeout needs --wait.', {
          field: 'timeout'
        })
      }
      const progress = cloudProgress(wait ? readCloudProgressMode(flags, json) : 'none', deps.now)
      const api = cloudClient(deps)
      const routine = await resolveRoutine(api, getRequiredStringFlag(flags, 'routine'))
      const routinePath = `/v1/routines/${encodeURIComponent(routine.id)}`
      let { run } = await api.request<{ run: RoutineRun }>('POST', `${routinePath}/run`)
      if (wait) {
        const limitMs =
          timeoutSeconds !== undefined
            ? timeoutSeconds * 1000
            : (routine.maxRuntimeMinutes ?? DEFAULT_RUNTIME_MINUTES) * 60_000 + WAIT_SLACK_MS
        const deadline = deps.now() + limitMs
        progress.phase(run.status, `${routine.name}: ${routineRunStateLabel(run.status)}`, {
          runId: run.id
        })
        while (!FINISHED.has(run.status)) {
          if (deps.now() >= deadline) {
            throw new RuntimeClientError(
              'cloud_routine_run_wait_timeout',
              `The run is still ${routineRunStateLabel(run.status).toLowerCase()} after ${formatElapsed(limitMs)}. It keeps going in Orca Cloud.`,
              { run }
            )
          }
          await deps.sleep(RUN_POLL_MS)
          const previous = run.status
          run = (
            await api.request<{ run: RoutineRun }>(
              'GET',
              `${routinePath}/runs/${encodeURIComponent(run.id)}`
            )
          ).run
          if (run.status !== previous) {
            progress.phase(run.status, `${routine.name}: ${routineRunStateLabel(run.status)}`, {
              runId: run.id
            })
          }
        }
        const failure = runFinishedError(routine, run)
        if (failure) {
          throw failure
        }
      }
      printCloudResult({ routine: { id: routine.id, name: routine.name }, run }, json, (value) =>
        formatRoutineRun(value)
      )
    }
  }
}
