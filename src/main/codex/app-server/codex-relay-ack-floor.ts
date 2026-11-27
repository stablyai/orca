import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'
import { CODEX_TEXT_ITEM_TYPES } from './codex-relay-item-continuation'

const ENVELOPE_SCAN_CHARS = 4096
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
const MAX_OPEN_ITEMS = 256
/** A running command's row is saved at checkpoints, so its output is held like streamed text. */
const HELD_ITEM_TYPES: ReadonlySet<string> = new Set([...CODEX_TEXT_ITEM_TYPES, 'commandExecution'])

function itemKey(line: string): { key: string; running: boolean; ends: readonly string[] } | null {
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
    !HELD_ITEM_TYPES.has(String(type))
  ) {
    return null
  }
  return {
    key: JSON.stringify([threadId, id]),
    running: status === undefined || status === 'inProgress',
    // A raw `"` can't sit inside a JSON string, so these match the item's own fields only.
    ends: [`"id":${JSON.stringify(id)}`, `"threadId":${JSON.stringify(threadId)}`]
  }
}

/** The open item a completion names, found without parsing its (possibly huge) text. */
function completedKey(line: string, ends: Map<string, readonly string[]>): string | null {
  for (const [key, needles] of ends) {
    if (needles.every((needle) => line.includes(needle))) {
      return key
    }
  }
  return null
}

/**
 * Codex items stream from `item/started` to `item/completed` and are keyed by their own ids, so a
 * reattach that replays an open item from its start rewrites the same row whole. Streamed text and
 * running commands are held: their rows are saved only at checkpoints, so output acked past one
 * would be gone after a crash. The daemon asks for a saved ack well before its memory cap, and an
 * item whose start it released then is held no more. Only `item/started` is parsed; a completion
 * is matched to its open item by substring, and every other line is passed by its envelope.
 */
export function createCodexRelayAckFloor(): ProviderRelayAckFloor {
  /** Insertion order is seq order, so the first entry is the floor. */
  const open = new Map<string, number>()
  /** Items whose end was handed on but maybe not yet taken: [start, end] by key. */
  const ending = new Map<string, [number, number]>()
  /** Each open item's own `id` and `threadId` fields, as they appear in its completion. */
  const needles = new Map<string, readonly string[]>()
  const forget = (key: string): void => {
    open.delete(key)
    needles.delete(key)
  }
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
      if (method === 'item/completed') {
        // Only an open item's end matters, and its text is never parsed to find it.
        const key = completedKey(line, needles)
        const start = key === null ? undefined : open.get(key)
        if (key !== null && start !== undefined) {
          forget(key)
          if (ending.size < MAX_OPEN_ITEMS) {
            ending.set(key, [start, seq])
          }
        }
        return
      }
      const item = itemKey(line)
      if (!item) {
        return
      }
      forget(item.key)
      if (item.running && open.size < MAX_OPEN_ITEMS) {
        open.set(item.key, seq)
        needles.set(item.key, item.ends)
      }
    },
    // An item whose end the reader hasn't taken yet still needs its start after a crash.
    floor: (through = Number.POSITIVE_INFINITY, released = 0) => {
      for (const [key, start] of open) {
        if (start > released) {
          break
        }
        forget(key)
      }
      let floor = open.values().next().value ?? null
      for (const [key, [start, end]] of ending) {
        if (end <= through || start <= released) {
          ending.delete(key)
        } else if (floor === null || start < floor) {
          floor = start
        }
      }
      return floor
    }
  }
}
