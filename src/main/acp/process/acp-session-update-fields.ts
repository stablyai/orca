import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'

/** The methods ACP agents send session updates under: the standard one and Grok's. */
export const ACP_SESSION_UPDATE_METHODS = new Set([
  'session/update',
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update'
])

/** Those and OpenCode's child sessions' updates, which carry their own messages and calls. */
const ACP_UPDATE_METHODS = new Set([
  ...ACP_SESSION_UPDATE_METHODS,
  'opencode/session/child_update',
  '_opencode/session/child_update'
])

const ENVELOPE_SCAN_CHARS = 4096
/** A long line's fields are read from its start and end; no line is parsed here. */
const FIELD_WINDOW_CHARS = 4096
/** More open items than this can't be real; the oldest stay held, so nothing is acked past them. */
export const ACP_MESSAGE_CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk'])
/** An OpenCode child's status report, read as an update of its session. */
const CHILD_STATUS = 'orca:child_status'
/** Updates after which no message of a session continues. A message with an id goes on past calls
 *  under that id (OpenCode keeps one per step) and may resume after another message; only these
 *  end it for good. */
export const ACP_MESSAGE_ENDS = new Set([CHILD_STATUS, 'user_message_chunk'])
/** Updates after which a session's next message starts whole in a replay; a message with an id may
 *  still resume past one. */
export const ACP_MESSAGE_BOUNDARIES = new Set(['tool_call', 'tool_call_update', 'plan'])

export type AcpUpdateFields = {
  sessionId?: string
  sessionUpdate?: string
  messageId?: string
  toolCallId?: string
  /** An OpenCode child session's update. */
  child?: boolean
}

/** A key outside any string: an unescaped quote can't sit inside a JSON string. */
const field = (name: string): RegExp => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
const SESSION_ID = field('sessionId')
const CHILD_SESSION_ID = field('childSessionId')
const SESSION_UPDATE = field('sessionUpdate')
const MESSAGE_ID = field('messageId')
const TOOL_CALL_ID = field('toolCallId')

/** The fields the floor needs, scanned from the line's ends. A call's end is read by the
 *  connection, which parses every line anyway (`AcpRelayTurns.observeUpdate`). */
function updateFields(line: string): AcpUpdateFields {
  const windows =
    line.length <= 2 * FIELD_WINDOW_CHARS
      ? [line]
      : [line.slice(0, FIELD_WINDOW_CHARS), line.slice(-FIELD_WINDOW_CHARS)]
  const find = (pattern: RegExp): string | undefined =>
    windows.map((text) => pattern.exec(text)?.[1]).find((value) => value !== undefined)
  const sessionUpdate = find(SESSION_UPDATE)
  if (sessionUpdate === 'tool_call') {
    return {
      sessionId: find(CHILD_SESSION_ID) ?? find(SESSION_ID),
      sessionUpdate,
      toolCallId: find(TOOL_CALL_ID)
    }
  }
  return {
    sessionId: find(CHILD_SESSION_ID) ?? find(SESSION_ID),
    sessionUpdate,
    ...(sessionUpdate && ACP_MESSAGE_CHUNKS.has(sessionUpdate)
      ? { messageId: find(MESSAGE_ID) }
      : {})
  }
}

/** A session update's fields, or null for any other line; only the envelope's start is read. */
export function acpSessionUpdateFields(line: string): AcpUpdateFields | null {
  const { properties } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: 8
  })
  const method = properties.find((property) => property.key === 'method')?.value
  if (typeof method !== 'string' || !ACP_UPDATE_METHODS.has(method)) {
    return null
  }
  const fields = updateFields(line)
  return ACP_SESSION_UPDATE_METHODS.has(method)
    ? fields
    : { ...fields, child: true, sessionUpdate: fields.sessionUpdate ?? CHILD_STATUS }
}

const CHILD_ENDED = /"status"\s*:\s*"(?:completed|failed|interrupted)"/

/** The OpenCode child session a status line reports ended, if this line is one. */
export function acpChildSessionEnded(line: string): string | null {
  const fields = acpSessionUpdateFields(line)
  return fields?.sessionUpdate === CHILD_STATUS && fields.sessionId && CHILD_ENDED.test(line)
    ? fields.sessionId
    : null
}
