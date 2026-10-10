// The ZCode app-server wire shapes Orca consumes, read defensively.
//
// The provider's schemas are zod-strict on ITS side; Orca reads the frames it
// needs by field, so a newer server adding fields (or an unknown event type)
// degrades to an ignored row instead of a dropped connection.

import type { NativeChatBlock } from '../../shared/native-chat-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One `session/event` notification's params, narrowed to what the journal reads. */
export type ZcodeSessionEvent = {
  type: string
  sessionId: string
  turnId?: string
  seq: number
  timestamp: number
  payload: Record<string, unknown>
}

/** Reads a `session/event` notification into the shape the translator consumes; null when the
 *  frame is not an event Orca can place. */
export function readZcodeSessionEvent(method: string, params: unknown): ZcodeSessionEvent | null {
  if (method !== 'session/event' || !isRecord(params)) {
    return null
  }
  const type = typeof params.type === 'string' ? params.type : null
  if (!type) {
    return null
  }
  return {
    type,
    sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
    ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    seq: typeof params.seq === 'number' ? params.seq : 0,
    timestamp: typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
    payload: params
  }
}

/** A `ZCodeMessageWithParts` as the snapshot and upsert events carry it. */
export type ZcodeMessageWithParts = {
  info: Record<string, unknown>
  parts: Record<string, unknown>[]
}

export function readZcodeMessageWithParts(raw: unknown): ZcodeMessageWithParts | null {
  if (!isRecord(raw)) {
    return null
  }
  const info = isRecord(raw.info) ? raw.info : raw
  const parts = Array.isArray(raw.parts)
    ? raw.parts.filter((part): part is Record<string, unknown> => isRecord(part))
    : []
  return { info, parts }
}

/** The text of a text/reasoning part; empty for anything else. */
export function readZcodePartText(part: Record<string, unknown>): string {
  const text = part.text
  return typeof text === 'string' ? text : ''
}

/** Flattens one ZCode message into render blocks: text, in part order. Reasoning text joins the
 *  same blocks; the renderer reads reasoning rows through the message's role, which ZCode's
 *  user/assistant split does not carry, so nothing here models it separately. */
export function readZcodeMessageParts(message: unknown): NativeChatBlock[] {
  const withParts = readZcodeMessageWithParts(message)
  if (!withParts) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const part of withParts.parts) {
    const type = part.type
    if ((type === 'text' || type === 'reasoning') && typeof part.text === 'string') {
      if (part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
      }
    }
    // Tool parts become their own tool-call items via the translator, not blocks.
  }
  return blocks
}

/** The session snapshot's fields Orca consumes: the provider session id and its messages. */
export type ZcodeSessionSnapshotSummary = {
  sessionId: string
  messages: unknown[]
}

export function readZcodeSnapshot(result: unknown): ZcodeSessionSnapshotSummary | null {
  if (!isRecord(result)) {
    return null
  }
  const session = isRecord(result.session) ? result.session : null
  const sessionId =
    session && typeof session.sessionId === 'string'
      ? session.sessionId
      : typeof result.sessionId === 'string'
        ? result.sessionId
        : null
  if (!sessionId) {
    return null
  }
  return {
    sessionId,
    messages: Array.isArray(result.messages) ? result.messages : []
  }
}

/** The permission request a ZCode reverse RPC asks Orca to answer. */
export type ZcodePermissionRequest = {
  requestId: string
  sessionId: string
  toolCallId?: string
  toolName: string
  reason?: string
  riskLevel?: string
  input: unknown
  options: { optionId: string; kind: string; name: string }[]
}

export function readZcodePermissionRequest(
  method: string,
  params: unknown
): ZcodePermissionRequest | null {
  if (method !== 'interaction/requestPermission' || !isRecord(params)) {
    return null
  }
  const toolName = typeof params.toolName === 'string' ? params.toolName : ''
  const options = Array.isArray(params.options)
    ? params.options.filter((option): option is Record<string, unknown> => isRecord(option))
    : []
  return {
    requestId: typeof params.requestId === 'string' ? params.requestId : '',
    sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
    ...(typeof params.toolCallId === 'string' ? { toolCallId: params.toolCallId } : {}),
    toolName,
    ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    ...(typeof params.riskLevel === 'string' ? { riskLevel: params.riskLevel } : {}),
    input: params.input ?? null,
    options: options.map((option) => ({
      optionId: typeof option.optionId === 'string' ? option.optionId : '',
      kind: typeof option.kind === 'string' ? option.kind : '',
      name: typeof option.name === 'string' ? option.name : ''
    }))
  }
}
