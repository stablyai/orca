// Validation + display normalization for the three tool-execution frames.
//
// Field names are canonical `AgentEvent` (packages/agent/src/types.ts) and are
// verified live against omp 18.0.11: `args` on start/update, `partialResult` on
// update, `result` on end — each result being a ToolResult envelope
// (`{content: ContentBlock[], details?}`), never a bare string. Flattening the
// envelope here rather than in the renderer keeps OMP's content-block grammar
// on the main side, where the transcript decoder already owns it: the same
// `toolResultOutput` handles a persisted `toolResult` record and this frame, so
// a live overlay row and its eventual transcript row read identically.

import type {
  OmpRpcToolExecutionEndFrame,
  OmpRpcToolExecutionStartFrame,
  OmpRpcToolExecutionUpdateFrame
} from '../../shared/omp-rpc-protocol'
import { toolResultOutput } from '../native-chat/transcript-record-blocks'
import { isOmpRpcObject } from './omp-rpc-frame-validation'

/** Both identity fields are optional upstream only in the sense that a frame
 *  from an older runtime may omit them; present-but-wrong-typed is a genuine
 *  shape violation, because the overlay pairs blocks by `toolCallId`. */
function hasValidToolIdentity(frame: Record<string, unknown>): boolean {
  return (
    (frame.toolCallId === undefined || typeof frame.toolCallId === 'string') &&
    (frame.toolName === undefined || typeof frame.toolName === 'string')
  )
}

export function parseOmpRpcToolExecutionStartFrame(
  frame: unknown
): OmpRpcToolExecutionStartFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'tool_execution_start' ||
    !hasValidToolIdentity(frame) ||
    (frame.intent !== undefined && typeof frame.intent !== 'string')
  ) {
    return null
  }
  return frame as OmpRpcToolExecutionStartFrame
}

export function parseOmpRpcToolExecutionUpdateFrame(
  frame: unknown
): OmpRpcToolExecutionUpdateFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'tool_execution_update' ||
    !hasValidToolIdentity(frame)
  ) {
    return null
  }
  return frame as OmpRpcToolExecutionUpdateFrame
}

export function parseOmpRpcToolExecutionEndFrame(
  frame: unknown
): OmpRpcToolExecutionEndFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'tool_execution_end' ||
    !hasValidToolIdentity(frame) ||
    (frame.isError !== undefined && typeof frame.isError !== 'boolean')
  ) {
    return null
  }
  return frame as OmpRpcToolExecutionEndFrame
}

/** Flattens a ToolResult envelope to the display string the overlay renders.
 *  An absent envelope yields '' rather than the string "undefined": a tool that
 *  reported no output is empty, not broken. */
export function ompRpcToolResultDisplayOutput(result: unknown): string {
  if (result === undefined || result === null) {
    return ''
  }
  return isOmpRpcObject(result) && 'content' in result
    ? toolResultOutput(result.content)
    : toolResultOutput(result)
}
