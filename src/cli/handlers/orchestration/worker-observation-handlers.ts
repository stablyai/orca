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
      dispatch: { id: string; taskId: string; status: string } | null
      worker: { state: string; stage: string; agentTerminalHandle: string | null }
      projection?: { liveness: { verdict: string }; nextAction: { argv: string[] } } | null
      observation?: { agentWait?: { source: string; reason?: string } | null }
    }>('orchestration.workerShow', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(result, json, (value) => {
      const lines = [
        `${value.dispatch?.id ?? 'unknown'} task=${value.dispatch?.taskId ?? 'unknown'} [${value.worker.state}] stage=${value.worker.stage}`
      ]
      // Why: PTY status alone read `live` for an agent that died at a trust prompt, so the
      // fleet verdict and its next action print beside it rather than in another command.
      if (value.projection) {
        lines.push(
          `Agent liveness: ${value.projection.liveness.verdict}`,
          `Next action: ${value.projection.nextAction.argv.join(' ') || 'none'}`
        )
      }
      // Why: absent means unknown on older runtimes, distinct from an evaluated null wait.
      if (value.observation === undefined || !('agentWait' in value.observation)) {
        lines.push('Interactive wait: unknown (not evaluated)')
      } else if (value.observation.agentWait) {
        const wait = value.observation.agentWait
        lines.push(
          `Waiting on a human: ${wait.reason ?? 'interactive prompt'} (via ${wait.source})`
        )
      } else {
        lines.push('Interactive wait: none')
      }
      return lines.join('\n')
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
