import { renderOrchestrationArgv, type OrchestrationAgentView } from '../agent-view'
import type { WorkerListRunScope } from './worker-list-run-scope'
import { isActionableOrchestrationFleetAttention } from '../../../shared/orchestration/fleet/orchestration-fleet-attention'
import { formatPrCommentRelativeTime } from '../../../shared/source-control/review-comments/pr-comment-time'
import type {
  RemoteWorkerServer,
  WorkerListResult,
  WorkerProjection,
  WorkerShowResult
} from './worker-view-results'

type WorkerShowFields = {
  dispatchId: string
  taskId?: string
  runId?: string
  followUpOf?: string
  state: string
  stage: string
  liveness?: string
  activity?: string
  lastActivity?: string
  terminal?: string
  terminalState?: string
  handedOnTo?: string
  workspace?: string
  server?: string
  asOf?: string
  lastReport?: string
  note?: string
  attention?: string[]
  waitingOnHuman?: string
  lastError?: string
  autoReleaseAt?: string
  coordinatedFrom?: string
  next?: string
}

export const WORKER_SHOW_VIEW: OrchestrationAgentView<WorkerShowResult, WorkerShowFields> = {
  fields: (value) => {
    const wait = value.observation?.agentWait
    // A handed-on terminal's row is its follow-up's; its release state is not this worker's.
    const ownTerminal = value.handedOnTo ? null : value.terminalResource
    return {
      dispatchId: value.dispatch?.id ?? value.worker.dispatchId ?? 'unknown',
      taskId: value.dispatch?.taskId,
      runId: value.dispatch?.runId ?? value.projection?.runId,
      followUpOf: value.dispatch?.followUpOf ?? undefined,
      state: value.worker.state,
      stage: value.worker.stage,
      liveness: livenessField(value.projection),
      activity: knownActivity(value.projection),
      lastActivity: lastActivity(value.projection),
      terminal: value.worker.agentTerminalHandle ?? ownTerminal?.terminalHandle ?? undefined,
      // The projection's accounting state matches worker-list; releaseState is the raw column.
      terminalState:
        value.projection?.resource?.terminalState ?? ownTerminal?.releaseState ?? undefined,
      handedOnTo: value.handedOnTo ?? undefined,
      workspace: value.projection?.workspace?.id ?? value.worker.worktreeId ?? undefined,
      server: value.server?.name,
      asOf: value.server?.asOf,
      lastReport: value.lastReport ?? undefined,
      note: value.server ? value.observation?.reason : undefined,
      attention: actionableAttention(value.projection),
      // Silence means checked and clear; an older host or unreadable pane never evaluated it.
      waitingOnHuman:
        value.observation === undefined || !('agentWait' in value.observation)
          ? 'unknown'
          : wait
            ? `${wait.reason ?? 'interactive prompt'} (via ${wait.source})`
            : undefined,
      lastError:
        value.worker.state === 'failed' &&
        // A paired server's record carries no terminal details.
        !value.server &&
        !value.worker.agentTerminalHandle &&
        !value.terminalResource
          ? `never started: ${value.worker.lastError ?? 'its start failed'}`
          : (value.worker.lastError ?? undefined),
      autoReleaseAt: value.autoReleaseAt ?? undefined,
      coordinatedFrom: value.coordinatedFrom ?? undefined,
      next: value.projection ? renderOrchestrationArgv(value.projection.nextAction.argv) : undefined
    }
  }
}

type WorkerListRow = {
  dispatchId: string
  taskId: string
  state: string
  outcome?: string
  liveness?: string
  agent?: string
  terminal?: string
  terminalState?: string
  workspace?: string
  host?: string
  coordinatedFrom?: string
  asOf?: string
  attention?: string[]
  autoReleaseAt?: string
  next?: string
}

type WorkerListFields = {
  workers: WorkerListRow[]
  scope: WorkerListRunScope
  nextCursor?: string
  warnings?: string[]
}

type ScopedWorkerList = WorkerListResult & { scope: WorkerListRunScope }

export const WORKER_LIST_VIEW: OrchestrationAgentView<ScopedWorkerList, WorkerListFields> = {
  fields: (value) => ({
    workers: value.workers.map((worker) => {
      const projection = worker.projection
      return {
        dispatchId: worker.dispatchId,
        taskId: worker.taskId,
        state: worker.workerState,
        outcome:
          projection?.outcome && projection.outcome !== worker.workerState
            ? projection.outcome
            : undefined,
        liveness: projection?.liveness.verdict,
        agent: projection?.provider
          ? `${projection.provider.id}${projection.provider.model ? `/${projection.provider.model}` : ''}`
          : undefined,
        terminal: worker.agentTerminalHandle ?? undefined,
        terminalState: worker.terminalState ?? undefined,
        // Older runtimes send no projection; the terminal resource row still names both.
        workspace: projection?.workspace?.id ?? worker.resource?.worktreeId ?? undefined,
        host: projection?.host.id ?? remoteHost(worker.server),
        coordinatedFrom: worker.coordinatedFrom ?? undefined,
        asOf: worker.server?.asOf,
        attention: actionableAttention(projection),
        autoReleaseAt: projection?.autoReleaseAt ?? worker.resource?.autoReleaseAt ?? undefined,
        next: projection
          ? renderOrchestrationArgv(projection.nextAction.argv)
          : olderHostReleaseNext(worker)
      }
    }),
    scope: value.scope,
    nextCursor: (value.page?.hasMore && value.page.nextCursor) || undefined,
    warnings: nonEmpty(workerListWarnings(value))
  }),
  // A host that did not answer leaves the inventory unconfirmed, not empty.
  failure: (value) => {
    const [first, ...rest] = value.partialHostErrors ?? []
    return first
      ? {
          code: 'worker_inventory_incomplete',
          message: `worker observations from ${[first, ...rest].map((error) => error.name).join(', ')} are incomplete (${first.code})`
        }
      : undefined
  }
}

/** A re-made pairing leaves the record, but its server no longer reports the worker here. */
export function remoteHost(server: RemoteWorkerServer | undefined): string | undefined {
  return server && (server.repaired ? `${server.name} (pairing re-made)` : server.name)
}

// Older runtimes send no projection and cannot close finished workers on their own.
function olderHostReleaseNext(worker: WorkerListResult['workers'][number]): string | undefined {
  return worker.terminalState === 'reclaimable' && !worker.resource?.autoReleaseAt
    ? renderOrchestrationArgv(['orchestration', 'worker-release', '--dispatch', worker.dispatchId])
    : undefined
}

function workerListWarnings(value: WorkerListResult): string[] {
  return [
    ...(value.warnings ?? []),
    ...(value.partialHostErrors ?? []).map(
      (error) =>
        `worker observations from ${error.name} (${error.environmentId}) are incomplete: ${error.code}; dispatches=${error.dispatchIds.join(',') || 'none'}`
    )
  ]
}

// Descriptive categories like root_completion or stale owe the coordinator nothing; --full keeps them.
function actionableAttention(
  projection: WorkerProjection | null | undefined
): string[] | undefined {
  return nonEmpty(projection?.attention?.categories.filter(isActionableOrchestrationFleetAttention))
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined
}

/** Name what could not be verified, so a lost host never reads like a stuck worker. */
function livenessField(projection: WorkerProjection | null | undefined): string | undefined {
  const liveness = projection?.liveness
  return liveness?.detail ? `${liveness.verdict} (${liveness.detail})` : liveness?.verdict
}

/** Only a live worker's activity is known; a finished turn is an idle agent, not finished work. A turn
 *  its own background tasks hold open is named for them, as last seen, even once its status is stale. */
function knownActivity(projection: WorkerProjection | null | undefined): string | undefined {
  const wait = projection?.stage.backgroundWait
  if (wait) {
    const [command, ...more] = wait.commands
    return `waiting on its background task${command ? ` \`${command}\`` : ''}${more.length ? ` (and ${more.length} more)` : ''}${sinceIso(wait.since)}`
  }
  if (projection?.liveness.verdict !== 'live' || projection.stage.activity === 'unknown') {
    return undefined
  }
  return projection.stage.activity === 'done' ? 'idle' : projection.stage.activity
}

function lastActivity(projection: WorkerProjection | null | undefined): string | undefined {
  const at = projection?.evidence?.lastObservedAt
  return knownActivity(projection) && typeof at === 'number'
    ? formatPrCommentRelativeTime(new Date(at).toISOString(), Date.now())
    : undefined
}

/** A relayed copy may carry a time no date can hold. */
function sinceIso(since: number): string {
  const date = new Date(since)
  return Number.isFinite(date.getTime()) ? ` since ${date.toISOString()}` : ''
}
