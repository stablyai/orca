import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import type { ProviderRelayItemContinuation } from '../../provider-relay/relayed-provider-continuation'

const ENVELOPE_SCAN_CHARS = 4096
/** Items whose row is streamed text: replaying part of one onto its saved row would cut it. */
export const CODEX_TEXT_ITEM_TYPES: ReadonlySet<string> = new Set([
  'agentMessage',
  'reasoning',
  'plan'
])
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
    const message: Message = JSON.parse(line)
    const { params } = message
    if (typeof params?.threadId !== 'string') {
      return null
    }
    if (TEXT_DELTA_METHODS.has(method)) {
      return typeof params.itemId === 'string' ? message : null
    }
    const item = params.item
    return typeof item?.id === 'string' && CODEX_TEXT_ITEM_TYPES.has(String(item.type))
      ? message
      : null
  } catch {
    return null
  }
}

const itemId = ({ params }: Message): string => String(params.itemId ?? params.item?.id)

/** Orca's own line (never Codex's): the continuation row of an item that ended goes. */
export const CODEX_RELAY_CONTINUATION_RETIRED = 'orca/relayContinuationRetired'
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
  // Codex's end carries the whole item: it goes to the saved row, and the continuation is retired.
  finish: (line, tag) => {
    const message = textItemLine(line)
    if (!message) {
      return [line]
    }
    const retired = {
      method: CODEX_RELAY_CONTINUATION_RETIRED,
      params: { threadId: message.params.threadId, itemId: continuationId(tag, itemId(message)) }
    }
    return [CODEX_RELAY_ITEM_CONTINUATION.rekey(line, tag), JSON.stringify(retired), line]
  },
  openGroup: 'turn',
  // Keys as CODEX_RELAY_WORK_MARKERS' `turn` group: [threadId].
  settles: (line) => {
    if (!line.includes('"turn/completed"') && !line.includes('"thread/closed"')) {
      return null
    }
    try {
      const { method, params }: Message = JSON.parse(line)
      return (method === 'turn/completed' || method === 'thread/closed') &&
        typeof params?.threadId === 'string'
        ? JSON.stringify([params.threadId])
        : null
    } catch {
      return null
    }
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
