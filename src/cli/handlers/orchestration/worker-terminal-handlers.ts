import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { printOrchestrationResult } from './agent-view'
import { WORKER_LIST_VIEW, type WorkerListResult } from './worker-agent-views'
import { WORKER_RELEASE_VIEW, workerStopFailure } from './worker-release-agent-view'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { formatWorkerRelease, type WorkerReleaseReceipt } from './worker-output'
import { formatWorkerListScope, resolveWorkerListRunScope } from './worker-list-run-scope'

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
  'orchestration worker-stop': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<{
      dispatchId: string
      state: string
      processAction: string
      lastError?: string
      warning?: string
    }>(client, flags, 'orchestration.workerStop', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => value,
        failure: workerStopFailure
      })
      return
    }
    if (result.result.state === 'stop_unknown') {
      process.exitCode = 1
    }
    printResult(
      result,
      json,
      (value) =>
        `Worker ${value.dispatchId} [${value.state}] process=${value.processAction}${value.lastError ? `\n${value.lastError}` : ''}${value.warning ? `\nWarning: ${value.warning}` : ''}`
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
                  : `]`
                const next = projection
                  ? ` next=${projection.nextAction.argv.join(' ') || 'none'}`
                  : ''
                const autoRelease = projection?.autoReleaseAt
                  ? ` auto-release=${projection.autoReleaseAt}`
                  : ''
                return `${worker.dispatchId} task=${worker.taskId} [${worker.workerState}${details} terminal=${worker.terminalState ?? 'none'}${autoRelease}${next}`
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
