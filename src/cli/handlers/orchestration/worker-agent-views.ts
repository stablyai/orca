import {
  renderOrchestrationArgv,
  resolveOrcaCommandsInText,
  type OrchestrationAgentView,
  type OrchestrationFailure
} from './agent-view'
import { withReceiptNext } from './receipt-next-text'
import { formatWorkerRelease, type WorkerReleaseReceipt } from './worker-output'
import { formatWorkerListScope, type WorkerListRunScope } from './worker-list-run-scope'

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

export function workerShowView(
  fullText: (value: WorkerShowResult) => string
): OrchestrationAgentView<WorkerShowResult, WorkerShowFields> {
  return {
    fields: (value) => {
      const wait = value.observation?.agentWait
      return {
        dispatchId: value.dispatch?.id ?? value.worker.dispatchId ?? 'unknown',
        taskId: value.dispatch?.taskId,
        runId: value.dispatch?.runId ?? value.projection?.runId,
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
        waitingOnHuman: wait
          ? `${wait.reason ?? 'interactive prompt'} (via ${wait.source})`
          : undefined,
        lastError: value.worker.lastError ?? undefined,
        autoReleaseAt: value.autoReleaseAt ?? undefined,
        next: value.projection
          ? renderOrchestrationArgv(value.projection.nextAction.argv)
          : undefined
      }
    },
    text: (fields) => {
      const lines = [
        `${fields.dispatchId} (${fields.taskId ?? 'unknown task'}): ${fields.state}, ${fields.stage}${fields.liveness ? `; agent liveness ${fields.liveness}` : ''}`,
        `Terminal ${fields.terminal ?? 'none'}${fields.terminalState ? ` (${fields.terminalState})` : ''} in workspace ${fields.workspace ?? 'unknown'}`
      ]
      if (fields.attention) {
        lines.push(`Attention: ${fields.attention.join(', ')}`)
      }
      if (fields.waitingOnHuman) {
        lines.push(`Waiting on a human: ${fields.waitingOnHuman}`)
      }
      if (fields.lastError) {
        lines.push(`Last error: ${fields.lastError}`)
      }
      if (fields.autoReleaseAt) {
        lines.push(`Auto-release: ${fields.autoReleaseAt}`)
      }
      return withReceiptNext(lines.join('\n'), fields)
    },
    fullText
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
    resource: unknown
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

export function workerListView(
  fullText: (value: ScopedWorkerList) => string
): OrchestrationAgentView<ScopedWorkerList, WorkerListFields> {
  return {
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
          workspace: projection?.workspace?.id,
          host: projection?.host.id,
          attention: nonEmpty(projection?.attention?.categories),
          autoReleaseAt: projection?.autoReleaseAt,
          next: projection ? renderOrchestrationArgv(projection.nextAction.argv) : undefined
        }
      }),
      scope: value.scope,
      nextCursor: (value.page?.hasMore && value.page.nextCursor) || undefined,
      warnings: nonEmpty(workerListWarnings(value))
    }),
    text: (fields) => {
      const rows = fields.workers.length
        ? fields.workers.map((worker) =>
            [
              worker.dispatchId,
              worker.taskId,
              worker.outcome ? `${worker.state}/${worker.outcome}` : worker.state,
              worker.liveness && `liveness=${worker.liveness}`,
              worker.agent && `agent=${worker.agent}`,
              `terminal=${worker.terminal ?? 'none'}${worker.terminalState ? ` (${worker.terminalState})` : ''}`,
              worker.workspace && `workspace=${worker.workspace}`,
              worker.host && worker.host !== 'local' && `host=${worker.host}`,
              worker.attention && `attention=${worker.attention.join(',')}`,
              worker.autoReleaseAt && `auto-release=${worker.autoReleaseAt}`,
              worker.next && `next=${worker.next}`
            ]
              .filter(Boolean)
              .join(' ')
          )
        : ['No workers found.']
      return [
        ...rows,
        formatWorkerListScope(fields.scope),
        ...(fields.nextCursor ? [`More: --cursor ${fields.nextCursor}`] : []),
        ...(fields.warnings ?? []).map((warning) => `Warning: ${warning}`)
      ].join('\n')
    },
    fullText
  }
}

export function workerListWarnings(value: WorkerListResult): string[] {
  return [
    ...(value.warnings ?? []),
    ...(value.partialHostErrors ?? []).map(
      (error) =>
        `worker observations from ${error.name} (${error.environmentId}) are incomplete: ${error.code}; dispatches=${error.dispatchIds.join(',') || 'none'}`
    )
  ]
}

type WorkerReleaseFields = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive?: string
  lastError?: string
  next?: string
}

export const WORKER_RELEASE_VIEW: OrchestrationAgentView<
  WorkerReleaseReceipt,
  WorkerReleaseFields
> = {
  fields: (value) => ({
    dispatchId: value.dispatchId,
    state: value.state,
    reason: value.reason,
    processAction: value.processAction,
    archive: value.archive?.source
      ? `${value.archive.source} [${value.archive.status ?? 'unknown'}]`
      : undefined,
    lastError: value.lastError,
    next: value.recovery && resolveOrcaCommandsInText(value.recovery)
  }),
  text: (fields) =>
    withReceiptNext(
      [
        `Worker ${fields.dispatchId} terminal [${fields.state}]${fields.reason ? ` reason=${fields.reason}` : ''} process=${fields.processAction}`,
        ...(fields.archive ? [`archive ${fields.archive}`] : []),
        ...(fields.lastError ? [fields.lastError] : [])
      ].join('\n'),
      fields
    ),
  fullText: formatWorkerRelease,
  // Retained, pending, and already-released are settled outcomes; only release_unknown fails.
  failure: (value) =>
    value.state === 'release_unknown'
      ? {
          code: 'release_unknown',
          message: value.lastError ?? `Release of ${value.dispatchId} is unconfirmed.`
        }
      : undefined
}

export function workerStopFailure(value: {
  dispatchId: string
  state: string
  lastError?: string
}): OrchestrationFailure | undefined {
  return value.state === 'stop_unknown'
    ? {
        code: 'stop_unknown',
        message: value.lastError ?? `Stop of ${value.dispatchId} is unconfirmed.`
      }
    : undefined
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined
}
