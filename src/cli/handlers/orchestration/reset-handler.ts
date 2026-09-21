import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'

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
    const result = await callOrchestrationMutation<{ reset: string }>(
      client,
      flags,
      'orchestration.reset',
      {
        all: flags.has('all') ? true : undefined,
        tasks: flags.has('tasks') ? true : undefined,
        messages: flags.has('messages') ? true : undefined
      }
    )
    printResult(result, json, (value) => `Reset: ${value.reset}`)
  }
}
