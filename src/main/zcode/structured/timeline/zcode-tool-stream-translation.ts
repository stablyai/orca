import { boundPayload } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'

// zcode's mid-turn stream: `model.streaming` text/reasoning deltas and `tool.updated` tool cards.
// The turn key comes from the translator, which tracks the current turn by its first frame.

const TOOL_OUTPUT_LIMITS = { inlineHeadBytes: 16 * 1024 }

export function zcodeModelStreamingEvents(
  payload: unknown,
  turnKey: string | null,
  providerSessionId: string
): ProviderTimelineEvent[] {
  const kind = readString(readRecord(payload)?.kind)
  const delta = readString(readRecord(payload)?.delta)
  if (!delta) {
    return []
  }
  const join = { thread: providerSessionId, ...(turnKey ? { turn: turnKey } : {}) }
  if (kind === 'text_delta') {
    return [
      {
        type: 'text.delta',
        item: { stream: turnKey ?? providerSessionId },
        channel: 'assistant',
        text: delta,
        join
      }
    ]
  }
  if (kind === 'reasoning_delta') {
    return [
      {
        type: 'text.delta',
        item: { stream: `${turnKey ?? providerSessionId}:reasoning` },
        channel: 'reasoning',
        text: delta,
        join
      }
    ]
  }
  // `tool_call` declarations cache the tool identity the following tool.updated frames carry.
  return []
}

export function zcodeToolUpdatedEvents(
  payload: unknown,
  turnKey: string | null,
  providerSessionId: string
): ProviderTimelineEvent[] {
  const record = readRecord(payload)
  const callId = readString(record?.toolCallId)
  if (!callId) {
    return []
  }
  const name = readString(record?.toolName) ?? 'tool'
  const kind = readString(record?.kind)
  const input = record?.input
  const join = { thread: providerSessionId, ...(turnKey ? { turn: turnKey } : {}) }
  const body = (state: 'running' | 'completed' | 'failed', output?: string | null) => ({
    kind: 'tool-call' as const,
    name,
    input,
    callId,
    state,
    ...(output ? { output: boundPayload(output, TOOL_OUTPUT_LIMITS) } : {})
  })
  if (kind === 'scheduled') {
    return [{ type: 'item.open', item: callId, body: body('running'), join }]
  }
  if (kind === 'started') {
    return [{ type: 'item.update', item: callId, body: body('running'), join }]
  }
  if (kind === 'progress') {
    const tail = readString(record?.outputTail) ?? readString(record?.stderrTail)
    return [
      ...(tail
        ? [{ type: 'item.update' as const, item: callId, body: body('running', tail), join }]
        : []),
      { type: 'activity', text: `${name}…` }
    ]
  }
  if (kind === 'result') {
    const output = readString(record?.output) ?? readString(record?.outputTail)
    return [
      { type: 'item.close', item: callId, body: body('completed', output), join },
      { type: 'activity', text: null }
    ]
  }
  if (kind === 'error') {
    const output = readString(record?.error) ?? readString(record?.message)
    return [{ type: 'item.close', item: callId, body: body('failed', output), join }]
  }
  return kind ? [{ type: 'provider.frame', frameKind: `tool.updated.${kind}`, payload, join }] : []
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
