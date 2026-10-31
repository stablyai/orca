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
import { RuntimeClientError } from '../../runtime-client'
import { withReceiptNext } from './receipt-next-text'
import { printOrchestrationResult } from './agent-view'
import { formatMessageViewText, toMessageView, type MessageView } from './message-agent-views'

type InboxResult = {
  messages: MessageSummary[]
  count: number
  scope?: string
  runBinding?: string | null
}

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
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          messageId: value.message.id,
          next: value.next
        })
      })
      return
    }
    printResult(result, json, (value) => withReceiptNext(`Replied ${value.message.id}`, value))
  },

  'orchestration inbox': async ({ flags, client, cwd, json }) => {
    const full = flags.has('full')
    const run = getOptionalStringFlag(flags, 'run')
    const explicitTerminal = getPresentStringFlag(flags, 'terminal')
    const terminal = run
      ? await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
      : explicitTerminal
    const result = await client.call<InboxResult>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal,
      terminalPaneKey:
        run && !explicitTerminal ? process.env.ORCA_PANE_KEY || undefined : undefined,
      run
    })
    if (run && result.result.scope !== `messages addressed to Run ${run}`) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The running Orca runtime does not support Run-scoped inbox reads. Update or restart Orca and try again.'
      )
    }
    if (!full) {
      printOrchestrationResult(result, json, {
        fields: (value): { messages: MessageView[] } => ({
          messages: value.messages.map((message) => toMessageView(message, { recipient: true }))
        }),
        text: (fields) =>
          fields.messages.length === 0
            ? 'No messages.'
            : fields.messages.map((view) => formatMessageViewText(view)).join('\n\n')
      })
      return
    }
    printResult(result, json, (value) => {
      if (value.count === 0) {
        if (value.scope) {
          const binding = value.runBinding ? ` Current Run binding: ${value.runBinding}.` : ''
          return `No ${value.scope}.${binding}`
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
