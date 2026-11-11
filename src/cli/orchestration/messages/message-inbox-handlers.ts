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
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { requirePeerMailCarrier } from '../identity/agent-server-route'
import { resolveOrchestrationTerminalHandle } from '../identity/terminal-identity'
import { RuntimeClientError } from '../../runtime/types'
import { withReceiptNext } from '../receipt-next-text'
import { printOrchestrationResult } from '../agent-view'
import { formatMessageViewText, toMessageView, type MessageView } from './message-agent-views'

type InboxResult = {
  messages: MessageSummary[]
  count: number
  scope?: string
  runBinding?: string | null
}

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
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
      body: getRequiredStringFlag(flags, 'body'),
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
        // An empty answer still says which inbox it read, matching the --full receipt.
        fields: (value): { messages: MessageView[]; scope?: string; runBinding?: string } => ({
          messages: value.messages.map((message) =>
            inboxRowView(toMessageView(message, { recipient: true }))
          ),
          ...(value.scope ? { scope: value.scope } : {}),
          ...(value.runBinding ? { runBinding: value.runBinding } : {})
        }),
        text: (fields) =>
          fields.messages.length === 0
            ? emptyInboxText(fields.scope, fields.runBinding)
            : fields.messages.map((view) => formatMessageViewText(view)).join('\n\n')
      })
      return
    }
    printResult(result, json, (value) => {
      if (value.count === 0) {
        return emptyInboxText(value.scope, value.runBinding ?? undefined)
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

/** An empty inbox names what it read; only an unscoped read stays generic. */
function emptyInboxText(scope?: string, runBinding?: string): string {
  if (!scope) {
    return 'No messages.'
  }
  const binding = runBinding ? ` Current Run binding: ${runBinding}.` : ''
  return `No ${scope}.${binding}`
}

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
