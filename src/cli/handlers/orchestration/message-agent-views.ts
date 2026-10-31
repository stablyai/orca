import {
  formatOrchestrationCheckText,
  formatUnacknowledgedDeliveryNotice,
  isLegacyReadOnlyMessage,
  type OrchestrationCheckOutput,
  type OrchestrationMessageSummary
} from '../../../shared/orchestration-check-output'
import { escapeTerminalControlCharacters } from '../../../shared/terminal-control-character-escape'
import { formatFieldPairs, orchestrationCliName, type OrchestrationAgentView } from './agent-view'
import { withReceiptNext } from './receipt-next-text'

/** A message as the agent acts on it: storage columns dropped, the payload parsed but kept apart. */
export type MessageView = {
  id: string
  type: string
  from: string
  to?: string
  subject?: string
  body?: string
  priority?: string
  readOnly?: true
  handled?: boolean
  // Kept nested so sender-written payload can never stand in for Orca's own fields.
  payload?: Record<string, unknown> | string
}

export function toMessageView(
  message: OrchestrationMessageSummary,
  options: { legacyCompatibilityActive?: boolean; recipient?: boolean } = {}
): MessageView {
  const type = message.type ?? 'status'
  return {
    id: message.id,
    type,
    from: message.from_handle.replace(/^dispatch:/, ''),
    ...(options.recipient && message.to_handle ? { to: message.to_handle } : {}),
    // ask stores a fixed subject; the body is the question.
    ...(message.subject && !(type === 'question' && message.subject === 'Question')
      ? { subject: message.subject }
      : {}),
    ...(message.body ? { body: message.body } : {}),
    ...(message.priority && message.priority !== 'normal' ? { priority: message.priority } : {}),
    ...(isLegacyReadOnlyMessage(message, options.legacyCompatibilityActive)
      ? { readOnly: true as const }
      : {}),
    ...(options.recipient && message.read !== undefined ? { handled: message.read === 1 } : {}),
    ...payloadView(message)
  }
}

// ask repeats the question in its payload; drop that copy, keep everything else as sent.
function payloadView(message: OrchestrationMessageSummary): Pick<MessageView, 'payload'> {
  if (!message.payload) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(message.payload)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      nestsDeeperThan(parsed, MAX_PAYLOAD_DEPTH)
    ) {
      return { payload: message.payload }
    }
    const entries = Object.entries(parsed).filter(
      ([key, value]) => !(key === 'question' && value === message.body)
    )
    return entries.length ? { payload: Object.fromEntries(entries) } : {}
  } catch {
    return { payload: message.payload }
  }
}

// Rendering recurses per level; a sender-built deep payload stays the string it was sent as.
const MAX_PAYLOAD_DEPTH = 8

function nestsDeeperThan(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') {
    return false
  }
  return depth === 0 || Object.values(value).some((child) => nestsDeeperThan(child, depth - 1))
}

export function formatMessageViewText(view: MessageView, replyCommand?: string): string {
  const flags = [
    view.priority === 'urgent' || view.priority === 'high'
      ? `[${view.priority.toUpperCase()}]`
      : '',
    view.readOnly ? '[legacy, read-only]' : '',
    view.handled === false ? '[unhandled]' : ''
  ].filter(Boolean)
  const lines = [
    `${view.id} ${view.type} from ${view.from}${view.to ? ` to ${view.to}` : ''}${flags.length ? ` ${flags.join(' ')}` : ''}`
  ]
  const indent = (text: string): string =>
    escapeTerminalControlCharacters(text)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  if (view.subject) {
    lines.push(indent(view.subject))
  }
  if (view.body) {
    lines.push(indent(view.body))
  }
  if (view.payload !== undefined) {
    lines.push(
      indent(
        `payload: ${typeof view.payload === 'string' ? view.payload : formatFieldPairs(view.payload)}`
      )
    )
  }
  if (replyCommand) {
    lines.push(`Reply: ${replyCommand}`)
  }
  return lines.join('\n')
}

/** Only a question awaits `reply`; reports and escalations name their own follow-up. */
function replyCommandFor(message: OrchestrationMessageSummary, view: MessageView, checked: string) {
  if (view.type !== 'question' || view.readOnly) {
    return undefined
  }
  const target = message.to_handle ?? checked
  const from =
    target.startsWith('run:') || target.startsWith('dispatch:') ? '' : ` --from ${target}`
  return `${orchestrationCliName()} orchestration reply --id ${message.id}${from} --body "..."`
}

export type CheckAgentResult = OrchestrationCheckOutput & { replayed?: boolean; next?: string }

type CheckFields = {
  messages: MessageView[]
  deliveryId?: string
  replayed?: true
  acknowledged?: string
  timedOut?: true
  cancelled?: true
  connectionLost?: true
  legacyCompatibility?: OrchestrationCheckOutput['legacyCompatibility']
  next?: string
}

export function checkView(
  checkedTerminal: string
): OrchestrationAgentView<CheckAgentResult, CheckFields> {
  return {
    fields: (value) => {
      const legacyCompatibilityActive = Boolean(
        value.legacyCompatibility && !value.legacyCompatibility.readOnly
      )
      return {
        messages: value.messages.map((message) =>
          toMessageView(message, { legacyCompatibilityActive })
        ),
        // Only an older host that does not ack on read needs the id back for --ack.
        deliveryId:
          value.deliveryId && value.deliveryAcknowledged !== true ? value.deliveryId : undefined,
        replayed: value.replayed ? true : undefined,
        acknowledged: value.acknowledged ?? undefined,
        timedOut: value.timedOut ? true : undefined,
        cancelled: value.cancelled ? true : undefined,
        connectionLost: value.connectionLost ? true : undefined,
        legacyCompatibility: value.legacyCompatibility,
        next: value.next
      }
    },
    text: (fields, value) => {
      // Legacy batches carry safety headers only today's formatter prints.
      if (fields.legacyCompatibility || !fields.messages.length) {
        return withReceiptNext(formatOrchestrationCheckText(value, checkedTerminal), fields)
      }
      const messages = fields.messages
        .map((view, index) =>
          formatMessageViewText(view, replyCommandFor(value.messages[index], view, checkedTerminal))
        )
        .join('\n\n')
      return withReceiptNext(
        messages + formatUnacknowledgedDeliveryNotice(fields.deliveryId),
        fields
      )
    },
    // An interrupted wait delivered nothing; the caller must not read it as an empty mailbox.
    failure: (value) =>
      value.cancelled || value.connectionLost
        ? {
            code: value.connectionLost ? 'check_connection_closed' : 'check_cancelled',
            message: value.connectionLost
              ? 'Wait cancelled because the connection closed; no messages were consumed.'
              : 'Wait cancelled; no messages were consumed.'
          }
        : undefined
  }
}
