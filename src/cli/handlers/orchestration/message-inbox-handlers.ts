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
import { withReceiptNext } from './receipt-next-text'

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{ message: { id: string }; next?: string }>(
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
    printResult(result, json, (value) => withReceiptNext(`Replied ${value.message.id}`, value))
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getPresentStringFlag(flags, 'terminal')
    })
    printResult(result, json, (value) => {
      if (value.count === 0) {
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
