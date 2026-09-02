import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { formatWorkerRelease, type WorkerReleaseReceipt } from './worker-output'

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

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
    // Why: only an unprovable close is a failure; retained/pending/already-released are settled answers.
    if (result.result.state === 'release_unknown') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-retain': async ({ flags, client, json }) => {
    const result = await callOrchestrationMutation<WorkerReleaseReceipt>(
      client,
      flags,
      'orchestration.workerRetain',
      { dispatch: getRequiredStringFlag(flags, 'dispatch') }
    )
    if (result.result.state === 'release_unknown') {
      process.exitCode = 1
    }
    printResult(result, json, formatWorkerRelease)
  },

  'orchestration worker-list': async ({ flags, client, json }) => {
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
    const result = await client.call<{
      workers: {
        dispatchId: string
        taskId: string
        runId: string
        workerState: string
        dispatchStatus: string
        agentTerminalHandle: string | null
        terminalState: string | null
        resource: unknown
      }[]
      counts: Record<string, number>
    }>('orchestration.workerList', {
      run: getOptionalStringFlag(flags, 'run'),
      terminalState
    })
    printResult(result, json, (value) => {
      if (value.workers.length === 0) {
        return 'No workers found.'
      }
      const rows = value.workers
        .map(
          (worker) =>
            `${worker.dispatchId} task=${worker.taskId} [${worker.workerState}] terminal=${worker.terminalState ?? 'none'}`
        )
        .join('\n')
      const counts = Object.entries(value.counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(' ')
      return counts ? `${rows}\nTerminals: ${counts}` : rows
    })
  }
}
