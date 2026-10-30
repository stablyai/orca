import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../../flags'
import {
  formatMessageReadOnlyTag,
  type OrchestrationMessageSummary as MessageSummary
} from '../../../shared/orchestration-check-output'
import { callOrchestrationMutation } from './mutation-request'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{ message: { id: string } }>(
      client,
      flags,
      'orchestration.reply',
      {
        id: getRequiredStringFlag(flags, 'id'),
        body: getRequiredStringFlag(flags, 'body'),
        run: getOptionalStringFlag(flags, 'run'),
        from
      }
    )
    printResult(result, json, (value) => `Replied ${value.message.id}`)
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const id = getOptionalStringFlag(flags, 'id')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      id,
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getPresentStringFlag(flags, 'terminal')
    })
    // Older hosts ignore id; never print their unrelated history as an exact lookup.
    if (id) {
      result.result.messages = result.result.messages.filter((message) => message.id === id)
      result.result.count = result.result.messages.length
    }
    printResult(result, json, (value) => {
      if (value.count === 0) {
        if (id) {
          return `Message ${id} was not returned; an older host may only search recent history. Rerun the same inbox command without --id, keeping its terminal and execution profile, with --full --limit 100 and look for ${id}; increase --limit to look farther back.`
        }
        return 'No messages.'
      }
      return value.messages
        .map((message) => {
          const head = `${message.id}${formatMessageReadOnlyTag(message)} ${message.from_handle} -> ${message.to_handle ?? '?'}: "${message.subject}"`
          if (!full) {
            return head
          }
          const parts = [head]
          if (message.body && message.body.length > 0) {
            parts.push(message.body)
          }
          if (message.payload) {
            parts.push(`[payload] ${message.payload}`)
          }
          return parts.join('\n')
        })
        .join(full ? '\n\n' : '\n')
    })
  }
}
