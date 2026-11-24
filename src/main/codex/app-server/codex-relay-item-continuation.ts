import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'

const ENVELOPE_SCAN_CHARS = 4096
/** Items whose row is streamed text: replaying part of one onto its saved row would cut it. */
const TEXT_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'plan'])
const TEXT_DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/plan/delta'
])

type Params = { threadId?: unknown; itemId?: unknown; item?: { id?: unknown; type?: unknown } }
type Message = { method: string; params: Params }

function textItemLine(line: string): Message | null {
  const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: 8
  })
  const method = properties.find((property) => property.key === 'method')?.value
  if (
    typeof method !== 'string' ||
    (method !== 'item/started' && method !== 'item/completed' && !TEXT_DELTA_METHODS.has(method))
  ) {
    return null
  }
  try {
    const message = JSON.parse(line) as Message
    const { params } = message
    if (typeof params?.threadId !== 'string') {
      return null
    }
    if (TEXT_DELTA_METHODS.has(method)) {
      return typeof params.itemId === 'string' ? message : null
    }
    const item = params.item
    return typeof item?.id === 'string' && TEXT_ITEM_TYPES.has(String(item.type)) ? message : null
  } catch {
    return null
  }
}

const itemId = ({ params }: Message): string => String(params.itemId ?? params.item?.id)
const continuationId = (tag: string, id: string): string => `${tag}:${id}`

/** Codex keys rows by item id, so a cut item continues under `<tag>:<item id>` in the same thread. */
export const CODEX_RELAY_ITEM_CONTINUATION: ProviderRelayItemContinuation = {
  item: (line) => {
    const message = textItemLine(line)
    return message
      ? {
          key: JSON.stringify([message.params.threadId, itemId(message)]),
          start: message.method === 'item/started',
          end: message.method === 'item/completed'
        }
      : null
  },
  rekey: (line, tag) => {
    const message = textItemLine(line)
    if (!message) {
      return line
    }
    const id = continuationId(tag, itemId(message))
    const params = message.params.item
      ? { ...message.params, item: { ...message.params.item, id } }
      : { ...message.params, itemId: id }
    return JSON.stringify({ ...message, params })
  },
  start: (line, tag) => {
    const message = textItemLine(line)
    const threadId = message?.params.threadId
    const id = message ? continuationId(tag, itemId(message)) : tag
    return JSON.stringify({
      method: 'item/started',
      params: { threadId, item: { type: 'agentMessage', id, status: 'inProgress' } }
    })
  }
}
