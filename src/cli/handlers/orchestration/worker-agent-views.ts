import { renderOrchestrationArgv, type OrchestrationAgentView } from './agent-view'
import type { WorkerListRunScope } from './worker-list-run-scope'

type WorkerProjection = {
  runId?: string
  outcome?: string | null
  provider?: { id: string; model: string | null } | null
  host: { id: string }
  workspace?: { id: string } | null
  stage: { activity: string }
  liveness: { verdict: string }
  nextAction: { argv: string[] }
  attention?: { categories: string[] }
  resource?: { terminalState?: string | null } | null
  autoReleaseAt?: string
}

export type WorkerShowResult = {
  dispatch: {
    id: string
    taskId: string
    runId?: string
    status: string
    followUpOf?: string | null
  } | null
  worker: {
    dispatchId?: string
    state: string
    stage: string
    agentTerminalHandle: string | null
    worktreeId?: string | null
    lastError?: string | null
  }
  projection?: WorkerProjection | null
  terminalResource?: {
    releaseState?: string | null
    terminalHandle?: string | null
  } | null
  observation?: { agentWait?: { source: string; reason?: string } | null }
  autoReleaseAt?: string | null
}

type WorkerShowFields = {
  dispatchId: string
  taskId?: string
  runId?: string
  followUpOf?: string
  state: string
  stage: string
  liveness?: string
  terminal?: string
  terminalState?: string
  workspace?: string
  attention?: string[]
  waitingOnHuman?: string
  lastError?: string
  autoReleaseAt?: string
  next?: string
}

export const WORKER_SHOW_VIEW: OrchestrationAgentView<WorkerShowResult, WorkerShowFields> = {
  fields: (value) => {
    const wait = value.observation?.agentWait
    return {
      dispatchId: value.dispatch?.id ?? value.worker.dispatchId ?? 'unknown',
      taskId: value.dispatch?.taskId,
      runId: value.dispatch?.runId ?? value.projection?.runId,
      followUpOf: value.dispatch?.followUpOf ?? undefined,
      state: value.worker.state,
      stage: value.worker.stage,
      liveness: value.projection?.liveness.verdict,
      terminal:
        value.worker.agentTerminalHandle ?? value.terminalResource?.terminalHandle ?? undefined,
      // The projection's accounting state matches worker-list; releaseState is the raw column.
      terminalState:
        value.projection?.resource?.terminalState ??
        value.terminalResource?.releaseState ??
        undefined,
      workspace: value.projection?.workspace?.id ?? value.worker.worktreeId ?? undefined,
      attention: nonEmpty(value.projection?.attention?.categories),
      // Silence means checked and clear; an older host or unreadable pane never evaluated it.
      waitingOnHuman:
        value.observation === undefined || !('agentWait' in value.observation)
          ? 'unknown'
          : wait
            ? `${wait.reason ?? 'interactive prompt'} (via ${wait.source})`
            : undefined,
      lastError: value.worker.lastError ?? undefined,
      autoReleaseAt: value.autoReleaseAt ?? undefined,
      next: value.projection ? renderOrchestrationArgv(value.projection.nextAction.argv) : undefined
    }
  }
}

export type WorkerListResult = {
  workers: {
    dispatchId: string
    taskId: string
    runId: string
    workerState: string
    dispatchStatus: string
    agentTerminalHandle: string | null
    terminalState: string | null
    resource?: { worktreeId?: string | null; autoReleaseAt?: string | null } | null
    projection?: WorkerProjection
  }[]
  counts: Record<string, number>
  page?: { hasMore: boolean; nextCursor: string | null; total: number }
  warnings?: string[]
  partialHostErrors?: {
    environmentId: string
    name: string
    code: string
    dispatchIds: string[]
  }[]
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
        host: projection?.host.id,
        attention: nonEmpty(projection?.attention?.categories),
        autoReleaseAt: projection?.autoReleaseAt ?? worker.resource?.autoReleaseAt ?? undefined,
        next: projection ? renderOrchestrationArgv(projection.nextAction.argv) : undefined
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

function workerListWarnings(value: WorkerListResult): string[] {
  return [
    ...(value.warnings ?? []),
    ...(value.partialHostErrors ?? []).map(
      (error) =>
        `worker observations from ${error.name} (${error.environmentId}) are incomplete: ${error.code}; dispatches=${error.dispatchIds.join(',') || 'none'}`
    )
  ]
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined
}
