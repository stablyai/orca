import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../../arguments/flags'
import {
  formatMessageReadOnlyTag,
  type OrchestrationMessageSummary as MessageSummary
} from '../../../shared/orchestration/mailbox/orchestration-check-output'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import { RuntimeClientError } from '../../runtime/connection/types'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { requirePeerMailCarrier } from '../identity/agent-server-route'
import { ORCHESTRATION_GROUP_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { resolveOrchestrationTerminalHandle } from '../identity/terminal-identity'
import { withReceiptNext } from '../receipt-next-text'
import { printOrchestrationResult } from '../agent-view'
import { formatMessageViewText, toMessageView, type MessageView } from './message-agent-views'

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration group-post': async ({ flags, client, cwd, json }) => {
    const { result: status } = await client.call<RuntimeStatus>('status.get')
    if (!status.capabilities?.includes(ORCHESTRATION_GROUP_CONVERSATION_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'server_mail_unsupported',
        'Update Orca on this bot’s computer to post group follow-ups. Nothing was queued.'
      )
    }
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{ messageId: string; status: 'queued' }>(
      client,
      flags,
      'orchestration.groupPost',
      {
        id: getRequiredStringFlag(flags, 'id'),
        body: await readTextOrFileFlag(flags, cwd, 'body', true),
        from
      }
    )
    printResult(
      result,
      json,
      ({ messageId }) => `Queued ${messageId} for the group host; not yet confirmed in the room.`
    )
  },
  'orchestration reply': async (ctx) => {
    const { flags, client, cwd, json } = ctx
    await requirePeerMailCarrier(ctx)
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{
      message: { id: string }
      warnings?: { message: string }[]
      next?: string
    }>(client, flags, 'orchestration.reply', {
      id: getRequiredStringFlag(flags, 'id'),
      body: await readTextOrFileFlag(flags, cwd, 'body', true),
      run: getOptionalStringFlag(flags, 'run'),
      on: getOptionalStringFlag(flags, 'on'),
      from
    })
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          messageId: value.message.id,
          warnings: value.warnings?.length
            ? value.warnings.map((warning) => warning.message)
            : undefined,
          next: value.next
        })
      })
      return
    }
    printResult(result, json, (value) =>
      withReceiptNext(
        [
          `Replied ${value.message.id}`,
          ...(value.warnings ?? []).map((warning) => `Warning: ${warning.message}`)
        ].join('\n'),
        value
      )
    )
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const run = getPresentStringFlag(flags, 'run')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getPresentStringFlag(flags, 'terminal'),
      run
    })
    // Why: a server older than v1.4.257 (reachable via --environment) drops `run` and returns every Run's mail.
    if (run && result.result.messages.some((message) => message.run_id !== run)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This server ignores --run. Update Orca on it, or use --terminal run:<run_id>.'
      )
    }
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
