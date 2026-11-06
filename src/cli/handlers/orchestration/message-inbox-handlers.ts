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
import { printOrchestrationResult } from './agent-view'
import { formatMessageViewText, toMessageView, type MessageView } from './message-agent-views'

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

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getPresentStringFlag(flags, 'terminal')
    })
    if (!full) {
      printOrchestrationResult(result, json, {
        fields: (value): { messages: MessageView[] } => ({
          messages: value.messages.map((message) =>
            inboxRowView(toMessageView(message, { recipient: true }))
          )
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

const INBOX_BODY_PREVIEW_CHARS = 200

// A sender can put anything under an id key; only short strings are ids.
function isShortId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 64
}

// inbox is history, not delivery: rows preview the body and keep only payload ids; check and --full print it whole.
function inboxRowView(view: MessageView): MessageView {
  const { body, payload, ...rest } = view
  const ids =
    payload && typeof payload === 'object'
      ? Object.entries(payload).filter(
          ([key, value]) =>
            /Ids?$/.test(key) &&
            (isShortId(value) || (Array.isArray(value) && value.every(isShortId)))
        )
      : []
  return {
    ...rest,
    ...(body
      ? {
          body: previewBody(body)
        }
      : {}),
    ...(ids.length ? { payload: Object.fromEntries(ids) } : {})
  }
}

// Code points, not UTF-16 units, so a cut never leaves half of a surrogate pair.
function previewBody(body: string): string {
  const characters = Array.from(body)
  return characters.length > INBOX_BODY_PREVIEW_CHARS
    ? `${characters.slice(0, INBOX_BODY_PREVIEW_CHARS).join('')}… (truncated; --full)`
    : body
}
