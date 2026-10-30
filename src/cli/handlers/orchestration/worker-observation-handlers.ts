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
      projection?: {
        liveness: { verdict: string }
        nextAction: { argv: string[] }
        attention?: { categories: string[] }
      } | null
      observation?: { agentWait?: { source: string; reason?: string } | null }
      autoReleaseAt?: string | null
    }>('orchestration.workerShow', {
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(result, json, (value) => {
      const lines = [
        `${value.dispatch?.id ?? 'unknown'} task=${value.dispatch?.taskId ?? 'unknown'} [${value.worker.state}] stage=${value.worker.stage}`
      ]
      // A live PTY can contain a dead agent; show the independent agent verdict and recovery action.
      if (value.projection) {
        lines.push(
          `Agent liveness: ${value.projection.liveness.verdict}`,
          `Next action: ${value.projection.nextAction.argv.join(' ') || 'none'}`
        )
        // `input` is a question the worker asked that awaits an answer, as worker-list shows.
        if (value.projection.attention) {
          lines.push(`Attention: ${value.projection.attention.categories.join(',') || 'none'}`)
        }
      }
      // Older runtimes omit agentWait; absence is unknown, distinct from an evaluated null.
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
      if (value.autoReleaseAt) {
        lines.push(`Auto-release: ${value.autoReleaseAt}`)
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
