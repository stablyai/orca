import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type {
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../../shared/orchestration-worker-output'
import { formatWorkerRead, type LegacyWorkerReadResult } from './worker-output'

export const ORCHESTRATION_WORKER_OBSERVATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration worker-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string }
      worker: { state: string; stage: string; agent_terminal_handle: string | null }
      observation?: { agentWait?: { source: string; reason?: string } | null }
    }>('orchestration.workerShow', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(result, json, (value) => {
      const base = `${value.dispatch.id} task=${value.dispatch.task_id} [${value.worker.state}] stage=${value.worker.stage}`
      // Why: absent means unknown on older runtimes, distinct from an evaluated null wait.
      if (value.observation === undefined || !('agentWait' in value.observation)) {
        return `${base}\nInteractive wait: unknown (not evaluated)`
      }
      const wait = value.observation.agentWait
      return wait
        ? `${base}\nWaiting on a human: ${wait.reason ?? 'interactive prompt'} (via ${wait.source})`
        : `${base}\nInteractive wait: none`
    })
  },

  'orchestration worker-read': async ({ flags, client, json }) => {
    const cursorFlag = getOptionalStringFlag(flags, 'cursor')
    const cursor =
      cursorFlag !== undefined && /^\d+$/.test(cursorFlag)
        ? Number.parseInt(cursorFlag, 10)
        : cursorFlag
    const source = getOptionalStringFlag(flags, 'source')
    if (source && !['auto', 'transcript', 'terminal'].includes(source)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--source must be auto, transcript, or terminal'
      )
    }
    const result = await client.call<OrchestrationWorkerReadResult | LegacyWorkerReadResult>(
      'orchestration.workerRead',
      {
        dispatch: getRequiredStringFlag(flags, 'dispatch'),
        cursor,
        limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
        source: source as OrchestrationWorkerReadSource | undefined
      }
    )
    printResult(result, json, formatWorkerRead)
  }
}
