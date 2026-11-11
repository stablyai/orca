import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { printOrchestrationResult } from './agent-view'
import { remoteHost, WORKER_LIST_VIEW, type WorkerListResult } from './worker-agent-views'
import {
  formatHelperStops,
  WORKER_RELEASE_VIEW,
  workerStopFailure
} from './worker-release-agent-view'
import type { WorkerStopReceipt } from '../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'
import { formatWorkerRelease, type WorkerReleaseReceipt } from './worker-output'
import { formatWorkerListScope, resolveWorkerListRunScope } from './worker-list-run-scope'

type WorkerApprovalAnswerView = {
  approvalId: string
  option: string
  reasonMessageId: string | null
}

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

const keepWorkerOpen: CommandHandler = async ({ flags, client, json }) => {
  const result = await callOrchestrationMutation<WorkerReleaseReceipt>(
    client,
    flags,
    'orchestration.workerRetain',
    { dispatch: getRequiredStringFlag(flags, 'dispatch') }
  )
  if (!flags.has('full')) {
    printOrchestrationResult(result, json, WORKER_RELEASE_VIEW)
    return
  }
  if (result.result.state === 'release_unknown') {
    process.exitCode = 1
  }
  printResult(result, json, formatWorkerRelease)
}

export const ORCHESTRATION_WORKER_TERMINAL_HANDLERS: Record<string, CommandHandler> = {
  'orchestration deny': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<WorkerApprovalAnswerView>(
      client,
      flags,
      'orchestration.approvalAnswer',
      {
        dispatch: getRequiredStringFlag(flags, 'dispatch'),
        prompt: getRequiredStringFlag(flags, 'prompt'),
        decision: 'deny',
        reason: getRequiredStringFlag(flags, 'reason'),
        from
      }
    )
    printOrchestrationResult(result, json, {
      fields: (value) => ({
        approvalId: value.approvalId,
        denied: value.option,
        reason: value.reasonMessageId
          ? `sent to the worker as message ${value.reasonMessageId}`
          : undefined
      })
    })
  },
  'orchestration worker-stop': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<WorkerStopReceipt>(
      client,
      flags,
      'orchestration.workerStop',
      {
        dispatch: getRequiredStringFlag(flags, 'dispatch')
      }
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => value,
        failure: workerStopFailure
      })
      return
    }
    if (workerStopFailure(result.result)) {
      process.exitCode = 1
    }
    printResult(
      result,
      json,
      (value) =>
        `Worker ${value.dispatchId} [${value.state}] process=${value.processAction}${value.lastError ? `\n${value.lastError}` : ''}${value.warning ? `\nWarning: ${value.warning}` : ''}${formatHelperStops(value.helpers)}${value.helperStopError ? `\n${value.helperStopError}` : ''}`
    )
  },

  'orchestration worker-abandon': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      dispatchId: string
      state: string
      warning: string
    }>(client, flags, 'orchestration.workerAbandon', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, { fields: (value) => value })
      return
    }
    printResult(
      result,
      json,
      (value) => `Worker ${value.dispatchId} [${value.state}]\nWarning: ${value.warning}`
    )
  },

  'orchestration worker-release': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRelease',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, WORKER_RELEASE_VIEW)
      return
    }
    // Retained, pending, and already-released are settled outcomes; only release_unknown fails.
    if (result.result.state === 'release_unknown') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-keep-open': keepWorkerOpen,
  'orchestration worker-retain': keepWorkerOpen,

  'orchestration worker-list': async ({ flags, client, cwd, json }) => {
    const terminalState = getOptionalStringFlag(flags, 'terminal-state')
    if (
      terminalState &&
      !WORKER_TERMINAL_LIST_STATES.includes(
        terminalState as (typeof WORKER_TERMINAL_LIST_STATES)[number]
      )
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid --terminal-state '${terminalState}', expected one of: ${WORKER_TERMINAL_LIST_STATES.join(', ')}`
      )
    }
    const scope = await resolveWorkerListRunScope(flags, cwd, client)
    const requiresCurrentListSemantics =
      flags.has('include-remote') || flags.has('cursor') || flags.has('limit')
    const result = await client.call<WorkerListResult>('orchestration.workerList', {
      paginate: true,
      run: scope.run,
      terminalState,
      ...(flags.has('include-remote') ? { includeRemote: true } : {}),
      on: getOptionalStringFlag(flags, 'on'),
      cursor: getOptionalStringFlag(flags, 'cursor'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    if (requiresCurrentListSemantics && !result.result.page) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The connected Orca runtime did not prove support for the requested worker-list flags, so no inventory was printed. Update the connected Orca runtime and retry.'
      )
    }
    if (!flags.has('full')) {
      printOrchestrationResult(
        { ...result, result: { ...result.result, scope } },
        json,
        WORKER_LIST_VIEW
      )
      return
    }
    printResult({ ...result, result: { ...result.result, scope } }, json, (value) => {
      const rows =
        value.workers.length === 0
          ? 'No workers found.'
          : value.workers
              .map((worker) => {
                const projection = worker.projection
                const provider = projection?.provider
                  ? `${projection.provider.id}${projection.provider.model ? `/${projection.provider.model}` : ''}`
                  : 'unknown'
                const workspace = projection?.workspace?.id ?? 'unknown'
                const stage = projection?.stage.activity ?? worker.dispatchStatus
                const liveness = projection?.liveness.verdict
                const attention = projection?.attention?.categories.join(',') || 'none'
                const details = projection
                  ? `/${stage}] attention=${attention} liveness=${liveness} provider=${provider} host=${projection.host.id} workspace=${workspace}`
                  : worker.server
                    ? `] host=${remoteHost(worker.server)} asOf=${worker.server.asOf}`
                    : `]`
                const next = projection
                  ? ` next=${projection.nextAction.argv.join(' ') || 'none'}`
                  : ''
                const autoRelease = projection?.autoReleaseAt
                  ? ` auto-release=${projection.autoReleaseAt}`
                  : ''
                const coordinatedFrom = worker.coordinatedFrom
                  ? ` coordinated from ${worker.coordinatedFrom}`
                  : ''
                return `${worker.dispatchId} task=${worker.taskId} [${worker.workerState}${details} terminal=${worker.terminalState ?? 'none'}${autoRelease}${next}${coordinatedFrom}`
              })
              .join('\n')
      const counts = Object.entries(value.counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(' ')
      const pagination =
        value.page?.hasMore && value.page.nextCursor
          ? `\nMore: --cursor ${value.page.nextCursor}`
          : ''
      const warnings = [
        ...(value.warnings ?? []),
        ...(value.partialHostErrors ?? []).map(
          (error) =>
            `worker observations from ${error.name} (${error.environmentId}) are incomplete: ${error.code}; dispatches=${error.dispatchIds.join(',') || 'none'}`
        )
      ].map((warning) => `Warning: ${warning}`)
      const warningBlock = warnings.length ? `\n${warnings.join('\n')}` : ''
      const scopeLine = `\n${formatWorkerListScope(value.scope ?? scope)}`
      return `${counts ? `${rows}\nTerminals: ${counts}` : rows}${scopeLine}${pagination}${warningBlock}`
    })
  }
}
