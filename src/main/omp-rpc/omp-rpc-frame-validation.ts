import type {
  OmpRpcAgentEndFrame,
  OmpRpcAssistantMessageEvent,
  OmpRpcConfigUpdateFrame,
  OmpRpcExtensionUiRequestFrame,
  OmpRpcMessagesPage,
  OmpRpcMessageUpdateFrame,
  OmpRpcReadyFrame,
  OmpRpcRecap,
  OmpRpcSessionInfoUpdateFrame,
  OmpRpcSessionState,
  OmpRpcSlashCommand
} from '../../shared/omp-rpc-protocol'
import {
  OMP_RPC_MAX_FRAME_BYTES,
  OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_MAX_MESSAGE_CURSOR_CHARS,
  OMP_RPC_PROTOCOL_VERSION
} from './omp-rpc-transport-limits'

export function isOmpRpcObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOmpRpcReadyFrame(value: unknown): OmpRpcReadyFrame | null {
  if (!isOmpRpcObject(value) || value.type !== 'ready' || value.protocolVersion !== 1) {
    return null
  }
  if (
    !Array.isArray(value.supportedProtocolVersions) ||
    !value.supportedProtocolVersions.every((version) => typeof version === 'number') ||
    !value.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION)
  ) {
    return null
  }
  // Why not equality against our own constants: the ready frame advertises the
  // SERVER's framing envelope precisely so a client can adapt to it. OMP ships
  // independently of Orca, so pinning one release's numbers would reject every
  // other release as "not a ready frame" and silently degrade the pane to PTY.
  // Only shape is checked here; the consumers (chunk reassembler, transport
  // line cap) size themselves from the advertised values.
  if (
    !isPositiveInteger(value.maxFrameBytes) ||
    !isPositiveInteger(value.maxReassembledFrameBytes) ||
    value.maxReassembledFrameBytes < value.maxFrameBytes ||
    value.maxFrameBytes > OMP_RPC_MAX_FRAME_BYTES ||
    value.maxReassembledFrameBytes > OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES
  ) {
    return null
  }
  return value as OmpRpcReadyFrame
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

export function parseOmpRpcCommands(value: unknown): OmpRpcSlashCommand[] {
  if (
    !Array.isArray(value) ||
    !value.every((command) => isOmpRpcObject(command) && typeof command.name === 'string')
  ) {
    throw new Error('OMP RPC command catalog was malformed')
  }
  return value as OmpRpcSlashCommand[]
}

export function parseOmpRpcCommandsData(data: unknown): OmpRpcSlashCommand[] {
  if (!isOmpRpcObject(data)) {
    throw new Error('OMP RPC command catalog response was malformed')
  }
  return parseOmpRpcCommands(data.commands)
}

export function parseOmpRpcRecap(value: unknown): OmpRpcRecap | null {
  if (
    !isOmpRpcObject(value) ||
    typeof value.text !== 'string' ||
    value.trigger !== 'idle' ||
    !Number.isSafeInteger(value.timestamp) ||
    (value.timestamp as number) < 0
  ) {
    return null
  }
  return value as OmpRpcRecap
}

/** An optional wire string: present-and-string, or absent/null. Both side
 *  channels carry `| undefined` upstream getters, so absent is valid; anything
 *  else (a number, an object) is a genuine shape violation. */
function isOptionalWireString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

export function parseOmpRpcSessionInfoUpdateFrame(
  frame: unknown
): OmpRpcSessionInfoUpdateFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'session_info_update' ||
    !isOptionalWireString(frame.title) ||
    !isOptionalWireString(frame.sessionId)
  ) {
    return null
  }
  return frame as OmpRpcSessionInfoUpdateFrame
}

export function parseOmpRpcConfigUpdateFrame(frame: unknown): OmpRpcConfigUpdateFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'config_update' ||
    !isOptionalWireString(frame.thinkingLevel)
  ) {
    return null
  }
  // `model` is the catalog's full Model object; only its shape as an object is
  // checked here — the three fields Orca reads are validated at read time.
  if (frame.model !== undefined && frame.model !== null && !isOmpRpcObject(frame.model)) {
    return null
  }
  return frame as OmpRpcConfigUpdateFrame
}

export function parseOmpRpcSessionState(data: unknown): OmpRpcSessionState {
  if (
    !isOmpRpcObject(data) ||
    (typeof data.sessionFile !== 'string' && data.sessionFile !== null) ||
    (typeof data.sessionId !== 'string' && data.sessionId !== null) ||
    typeof data.isStreaming !== 'boolean' ||
    typeof data.isCompacting !== 'boolean' ||
    !Number.isSafeInteger(data.queuedMessageCount) ||
    (data.queuedMessageCount as number) < 0
  ) {
    throw new Error('OMP RPC session state response was malformed')
  }
  return data as OmpRpcSessionState
}

/** `get_messages_page` payload. `nextCursor` is echoed straight back upstream, so
 *  its length is bounded here against upstream's own cursor ceiling rather than
 *  written back unchecked. Message shape stays unvalidated (D3 floor). */
export function parseOmpRpcMessagesPage(data: unknown): OmpRpcMessagesPage {
  if (
    !isOmpRpcObject(data) ||
    !Array.isArray(data.messages) ||
    !data.messages.every(isOmpRpcObject) ||
    !Number.isSafeInteger(data.totalMessages) ||
    (data.totalMessages as number) < 0 ||
    (data.nextCursor !== undefined &&
      (typeof data.nextCursor !== 'string' ||
        data.nextCursor.length === 0 ||
        data.nextCursor.length > OMP_RPC_MAX_MESSAGE_CURSOR_CHARS))
  ) {
    throw new Error('OMP RPC message page response was malformed')
  }
  return data as OmpRpcMessagesPage
}

/** Text/thinking triplet members carry their delta at byte level; every other
 *  documented member (start/*_start/*_end/image_end/done/error) is a bare or
 *  loosely-shaped tag. Unknown member types pass through untouched (D3 floor). */
export function parseOmpRpcAssistantMessageEvent(
  value: unknown
): OmpRpcAssistantMessageEvent | null {
  if (!isOmpRpcObject(value) || typeof value.type !== 'string') {
    return null
  }
  if (
    (value.type === 'text_delta' || value.type === 'thinking_delta') &&
    typeof value.delta !== 'string'
  ) {
    return null
  }
  return value as OmpRpcAssistantMessageEvent
}

/** An absent `assistantMessageEvent` is a VALID, non-fatal shape — verified
 *  live: OMP echoes the user's own turn through `message_update` with
 *  `message.role:'user'` and no `assistantMessageEvent` at all. Fault only
 *  when the field is present but fails its own shape check. */
export function parseOmpRpcMessageUpdateFrame(frame: unknown): OmpRpcMessageUpdateFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'message_update') {
    return null
  }
  if (frame.assistantMessageEvent === undefined) {
    return {
      ...frame,
      type: 'message_update',
      assistantMessageEvent: undefined
    } as OmpRpcMessageUpdateFrame
  }
  const assistantMessageEvent = parseOmpRpcAssistantMessageEvent(frame.assistantMessageEvent)
  if (!assistantMessageEvent) {
    return null
  }
  return { ...frame, type: 'message_update', assistantMessageEvent } as OmpRpcMessageUpdateFrame
}

export function parseOmpRpcAgentEndFrame(frame: unknown): OmpRpcAgentEndFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'agent_end') {
    return null
  }
  if (frame.messages !== undefined && !Array.isArray(frame.messages)) {
    return null
  }
  if (frame.isTerminal !== undefined && typeof frame.isTerminal !== 'boolean') {
    return null
  }
  return frame as OmpRpcAgentEndFrame
}

export function parseOmpRpcExtensionUiRequestFrame(
  frame: unknown
): OmpRpcExtensionUiRequestFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'extension_ui_request' ||
    typeof frame.id !== 'string' ||
    typeof frame.method !== 'string'
  ) {
    return null
  }
  if (frame.options !== undefined) {
    if (!Array.isArray(frame.options) || !frame.options.every((o) => typeof o === 'string')) {
      return null
    }
  }
  return frame as OmpRpcExtensionUiRequestFrame
}
