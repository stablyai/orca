import type { CommandHandler } from '../../dispatch/dispatch'
import { printOrchestrationReceipt } from '../agent-view'
import { RuntimeClientError } from '../../runtime/connection/types'
import type { ResetRemovedWork } from '../../../shared/orchestration/orchestration-removed-work'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { formatResetResult } from './removed-work-format'

export const ORCHESTRATION_RESET_HANDLER: Record<string, CommandHandler> = {
  'orchestration reset': async ({ flags, client, json }) => {
    const scopeCount = [flags.has('all'), flags.has('tasks'), flags.has('messages')].filter(
      Boolean
    ).length
    if (scopeCount !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one reset scope: --all, --tasks, or --messages.'
      )
    }
    const result = await callOrchestrationMutation<{ reset: string; removed?: ResetRemovedWork }>(
      client,
      flags,
      'orchestration.reset',
      {
        all: flags.has('all') ? true : undefined,
        tasks: flags.has('tasks') ? true : undefined,
        messages: flags.has('messages') ? true : undefined
      }
    )
    printOrchestrationReceipt(result, { flags, json }, formatResetResult)
  }
}
