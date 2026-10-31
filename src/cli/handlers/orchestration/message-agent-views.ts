import {
  formatOrchestrationCheckText,
  formatUnacknowledgedDeliveryNotice,
  isLegacyReadOnlyMessage,
  type OrchestrationCheckOutput,
  type OrchestrationMessageSummary
} from '../../../shared/orchestration-check-output'
import { escapeTerminalControlCharacters } from '../../../shared/terminal-control-character-escape'
import {
  orchestrationCliName,
  resolveOrcaCommandsInText,
  type OrchestrationAgentView
} from './agent-view'
import { withReceiptNext } from './receipt-next-text'

/** A message as the agent acts on it: payload flattened, routing and storage columns dropped. */
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
  [payloadField: string]: unknown
}

// `payload` is reserved too: payload fields that collide with view keys are kept under it.
const MESSAGE_VIEW_KEYS = new Set([
  'id',
  'type',
  'from',
  'to',
  'subject',
  'body',
  'priority',
  'payload'
])

export function toMessageView(
  message: OrchestrationMessageSummary,
  options: { legacyCompatibilityActive?: boolean; recipient?: boolean } = {}
): MessageView {
  const payload = parsePayload(message.payload)
  const type = message.type ?? 'status'
  const dispatchId = typeof payload?.dispatchId === 'string' ? payload.dispatchId : undefined
  const view: MessageView = {
    id: message.id,
    type,
    // A worker's report names it by Dispatch, not by the terminal that sent it.
    from: dispatchId ?? message.from_handle.replace(/^dispatch:/, ''),
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
    ...(options.recipient && message.read !== undefined ? { handled: message.read === 1 } : {})
  }
  if (payload === undefined) {
    return message.payload ? { ...view, payload: message.payload } : view
  }
  const collisions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (
      (key === 'dispatchId' && value === dispatchId) ||
      (key === 'question' && value === message.body)
    ) {
      continue
    }
    if (MESSAGE_VIEW_KEYS.has(key) || key in view) {
      collisions[key] = value
    } else {
      view[key] = value
    }
  }
  return Object.keys(collisions).length ? { ...view, payload: collisions } : view
}

function parsePayload(payload: string | null | undefined): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined
  } catch {
    return undefined
  }
}

export function formatMessageViewText(view: MessageView, replyCommand?: string): string {
  const status = view.outcome ?? view.stopReason
  const flags = [
    view.priority === 'urgent' || view.priority === 'high'
      ? `[${view.priority.toUpperCase()}]`
      : '',
    view.readOnly ? '[legacy, read-only]' : '',
    view.handled === false ? '[unhandled]' : ''
  ].filter(Boolean)
  const lines = [
    `${view.id} ${view.type} from ${view.from}${view.to ? ` to ${view.to}` : ''}${typeof view.taskId === 'string' ? ` (${view.taskId})` : ''}${typeof status === 'string' ? `: ${status}` : ''}${flags.length ? ` ${flags.join(' ')}` : ''}`
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
  for (const [key, value] of Object.entries(view)) {
    if (MESSAGE_VIEW_KEYS.has(key) || PRINTED_PAYLOAD_KEYS.has(key)) {
      continue
    }
    lines.push(indent(`${key}: ${formatPayloadValue(value)}`))
  }
  if (replyCommand) {
    lines.push(`Reply: ${replyCommand}`)
  }
  return lines.join('\n')
}

const PRINTED_PAYLOAD_KEYS = new Set(['taskId', 'outcome', 'stopReason', 'readOnly', 'handled'])

function formatPayloadValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(' | ')
  }
  return JSON.stringify(value)
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
  formatted?: string
  next?: string
}

export function checkView(
  checkedTerminal: string
): OrchestrationAgentView<CheckAgentResult, CheckFields> {
  const fullText = (value: CheckAgentResult): string =>
    withReceiptNext(formatOrchestrationCheckText(value, checkedTerminal), value)
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
        // --format asked for the agent-readable banners themselves.
        formatted: value.formatted,
        next: value.next && resolveOrcaCommandsInText(value.next)
      }
    },
    text: (fields, value) => {
      // Legacy and preformatted batches carry safety headers only the full formatter prints.
      if (fields.legacyCompatibility || value.formatted !== undefined || !fields.messages.length) {
        return withReceiptNext(
          formatOrchestrationCheckText(value, checkedTerminal, orchestrationCliName()),
          fields
        )
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
    fullText,
    // An interrupted wait delivered nothing; the caller must not read it as an empty mailbox.
    failure: (value) =>
      value.cancelled || value.connectionLost
        ? {
            code: value.connectionLost ? 'check_connection_closed' : 'check_cancelled',
            // Newly classified as a failure; --full keeps the exit 0 scripts saw.
            fullExitCode: 0,
            message: value.connectionLost
              ? 'Wait cancelled because the connection closed; no messages were consumed.'
              : 'Wait cancelled; no messages were consumed.'
          }
        : undefined
  }
}
