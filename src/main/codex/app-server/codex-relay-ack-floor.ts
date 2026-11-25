import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'
import { CODEX_TEXT_ITEM_TYPES } from './codex-relay-item-continuation'

const ENVELOPE_SCAN_CHARS = 4096
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
const MAX_OPEN_ITEMS = 256

function itemKey(line: string): { key: string; running: boolean } | null {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return null
  }
  const params = jsonProperty(message, 'params')
  const item = jsonProperty(params, 'item')
  const threadId = jsonProperty(params, 'threadId')
  const id = jsonProperty(item, 'id')
  const status = jsonProperty(item, 'status')
  const type = jsonProperty(item, 'type')
  if (
    typeof threadId !== 'string' ||
    typeof id !== 'string' ||
    !CODEX_TEXT_ITEM_TYPES.has(String(type))
  ) {
    return null
  }
  return {
    key: JSON.stringify([threadId, id]),
    running: status === undefined || status === 'inProgress'
  }
}

/**
 * Codex items stream from `item/started` to `item/completed` and are keyed by their own ids, so a
 * reattach that replays an open item from its start rewrites the same row whole. Only streamed text
 * items are held: a command's end carries its whole output, so a replay from mid-command loses
 * nothing. Only those two notifications are parsed; every other line is passed by its envelope.
 */
export function createCodexRelayAckFloor(): ProviderRelayAckFloor {
  /** Insertion order is seq order, so the first entry is the floor. */
  const open = new Map<string, number>()
  return {
    observe: (seq, line) => {
      const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
        stopAtContainer: true,
        maxFields: 8
      })
      const method = properties.find((property) => property.key === 'method')?.value
      if (method !== 'item/started' && method !== 'item/completed') {
        return
      }
      const item = itemKey(line)
      if (!item) {
        return
      }
      open.delete(item.key)
      if (method === 'item/started' && item.running && open.size < MAX_OPEN_ITEMS) {
        open.set(item.key, seq)
      }
    },
    floor: () => open.values().next().value ?? null
  }
}
