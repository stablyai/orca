import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'
import type { ProviderRelayAckFloor } from '../../provider-relay/relayed-provider-output'

/** The methods ACP agents send session updates under: the standard one and Grok's. */
export const ACP_SESSION_UPDATE_METHODS = new Set([
  'session/update',
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update'
])

const ENVELOPE_SCAN_CHARS = 4096
/** Lines longer than this are parsed for their fields instead of scanned. */
const FIELD_SCAN_CHARS = 16 * 1024
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
const MAX_OPEN_ITEMS = 256
const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk'])
/** Updates after which a message's chunks don't continue (as the translator numbers them). */
const MESSAGE_ENDS = new Set(['user_message_chunk', 'tool_call', 'tool_call_update', 'plan'])

type UpdateFields = {
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
  status?: string
}

/** A key outside any string: an unescaped quote can't sit inside a JSON string. */
const field = (name: string): RegExp => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
const SESSION_UPDATE = field('sessionUpdate')
const MESSAGE_ID = field('messageId')
const TOOL_CALL_ID = field('toolCallId')
/** Only a call's own end status is parsed for, so a nested `status` never closes it. */
const MAY_END = /"status"\s*:\s*"(?:completed|failed)"/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The record under `key`, or undefined. */
const child = (value: unknown, key: string): Record<string, unknown> | undefined => {
  const found = isRecord(value) ? value[key] : undefined
  return isRecord(found) ? found : undefined
}

function parsedUpdate(line: string): UpdateFields {
  const update = child(child(jsonRpcLine(line), 'params'), 'update')
  const text = (key: string): string | undefined => {
    const value = update?.[key]
    return typeof value === 'string' ? value : undefined
  }
  return {
    sessionUpdate: text('sessionUpdate'),
    messageId: text('messageId'),
    toolCallId: text('toolCallId'),
    status: text('status')
  }
}

function updateFields(line: string): UpdateFields {
  if (line.length > FIELD_SCAN_CHARS) {
    return parsedUpdate(line)
  }
  const sessionUpdate = SESSION_UPDATE.exec(line)?.[1]
  if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
    return MAY_END.test(line)
      ? parsedUpdate(line)
      : { sessionUpdate, toolCallId: TOOL_CALL_ID.exec(line)?.[1] }
  }
  return {
    sessionUpdate,
    ...(sessionUpdate && CHUNKS.has(sessionUpdate) ? { messageId: MESSAGE_ID.exec(line)?.[1] } : {})
  }
}

function jsonRpcLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A prompt's answer ends its turn; answers to other requests carry no stop reason. */
function isPromptAnswer(line: string): boolean {
  return (
    line.includes('"stopReason"') &&
    typeof child(jsonRpcLine(line), 'result')?.stopReason === 'string'
  )
}

const first = (open: Map<string, number>): number | null => open.values().next().value ?? null

/**
 * ACP's acks stay below the start of each open call (until its final status) and open message
 * (until a call, plan or the turn's end follows it), so a reattach replays each from its first
 * line and rewrites its row whole. Messages without ids are numbered within their turn, so until
 * the agent shows it gives ids (and in any turn with one without), the turn's first line holds
 * the floor until the prompt's answer: the replay numbers them again as the live run did. Only
 * session updates and answers are read past their envelope.
 */
export function createAcpRelayAckFloor(): ProviderRelayAckFloor {
  /** Insertion order is seq order, so the first entry is the earliest. */
  const calls = new Map<string, number>()
  const messages = new Map<string, number>()
  /** The first line since the last prompt's answer. */
  let turnStart: number | null = null
  let numbered = false
  let givesIds = false
  const open = (map: Map<string, number>, key: string, seq: number): void => {
    if (!map.has(key) && map.size < MAX_OPEN_ITEMS) {
      map.set(key, seq)
    }
  }
  return {
    observe: (seq, line) => {
      const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
        stopAtContainer: true,
        maxFields: 8
      })
      const method = properties.find((property) => property.key === 'method')?.value
      if (method === undefined && properties.some((p) => p.key === 'id') && isPromptAnswer(line)) {
        calls.clear()
        messages.clear()
        turnStart = null
        numbered = false
        return
      }
      turnStart ??= seq
      if (typeof method !== 'string' || !ACP_SESSION_UPDATE_METHODS.has(method)) {
        return
      }
      const update = updateFields(line)
      const kind = update.sessionUpdate
      if (kind && MESSAGE_ENDS.has(kind)) {
        messages.clear()
      }
      if (kind && CHUNKS.has(kind)) {
        if (update.messageId === undefined) {
          numbered = true
        } else {
          givesIds = true
          open(messages, update.messageId, seq)
        }
      }
      if ((kind === 'tool_call' || kind === 'tool_call_update') && update.toolCallId) {
        if (update.status === 'completed' || update.status === 'failed') {
          calls.delete(update.toolCallId)
        } else if (kind === 'tool_call') {
          open(calls, update.toolCallId, seq)
        }
      }
    },
    floor: () => {
      const starts = [first(calls), first(messages), numbered || !givesIds ? turnStart : null]
      const held = starts.filter((seq): seq is number => seq !== null)
      return held.length > 0 ? Math.min(...held) : null
    }
  }
}
