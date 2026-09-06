// Resolves a parsed OMP RPC server frame into the client event it emits, for
// every frame type beyond the bare transport frames OmpRpcClient still
// handles directly (rpc_chunk reassembly, response correlation).

import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'
import {
  parseOmpRpcAgentEndFrame,
  parseOmpRpcCommands,
  parseOmpRpcConfigUpdateFrame,
  parseOmpRpcExtensionUiRequestFrame,
  parseOmpRpcMessageUpdateFrame,
  parseOmpRpcRecap,
  parseOmpRpcSessionInfoUpdateFrame
} from './omp-rpc-frame-validation'
import { isOmpRpcSessionEventFrame } from '../../shared/omp-rpc-session-event-frames'
import {
  parseOmpRpcSubagentEventFrame,
  parseOmpRpcSubagentLifecycleFrame,
  parseOmpRpcSubagentProgressFrame
} from './omp-rpc-subagent-frames'
import {
  ompRpcToolResultDisplayOutput,
  parseOmpRpcToolExecutionEndFrame,
  parseOmpRpcToolExecutionStartFrame,
  parseOmpRpcToolExecutionUpdateFrame
} from './omp-rpc-tool-execution-frames'

export type OmpRpcServerFrameResolution = { event: OmpRpcClientEvent } | { fault: string } | null

/** Frame types forwarded as-is via a plain `{kind, frame}` event: their field
 *  shapes beyond a `type` tag are UNKNOWN at byte level (D3 floor) — pass the
 *  whole parsed object through rather than pretending to validate it. */
const PASSTHROUGH_FRAME_KINDS: Record<string, OmpRpcClientEvent['kind']> = {
  agent_start: 'agent-start',
  turn_start: 'turn-start',
  turn_end: 'turn-end',
  message_start: 'message-start',
  message_end: 'message-end'
}

/** Subagent frames only arrive once `set_subagent_subscription` turned them
 *  on, so an unusable payload here is a genuine contract break, not an
 *  unsupported-runtime shrug — the roster keys on the very fields it drops. */
function resolveSubagentFrameEvent(
  frame: Record<string, unknown> & { type: string }
): OmpRpcServerFrameResolution | null {
  if (frame.type === 'subagent_lifecycle') {
    const lifecycle = parseOmpRpcSubagentLifecycleFrame(frame)
    return lifecycle
      ? { event: { kind: 'subagent-lifecycle', frame: lifecycle } }
      : { fault: 'OMP RPC subagent_lifecycle frame was malformed' }
  }
  if (frame.type === 'subagent_progress') {
    const progress = parseOmpRpcSubagentProgressFrame(frame)
    return progress
      ? { event: { kind: 'subagent-progress', frame: progress } }
      : { fault: 'OMP RPC subagent_progress frame was malformed' }
  }
  if (frame.type === 'subagent_event') {
    const subagentEvent = parseOmpRpcSubagentEventFrame(frame)
    return subagentEvent
      ? { event: { kind: 'subagent-event', frame: subagentEvent } }
      : { fault: 'OMP RPC subagent_event frame was malformed' }
  }
  return null
}

/** The three tool frames are the one lifecycle family whose payload the
 *  renderer cannot read raw — resolved here so the ToolResult envelope is
 *  flattened once, main-side, instead of at every render. */
function resolveToolExecutionFrameEvent(
  frame: Record<string, unknown> & { type: string }
): OmpRpcServerFrameResolution | null {
  if (frame.type === 'tool_execution_start') {
    const start = parseOmpRpcToolExecutionStartFrame(frame)
    return start
      ? { event: { kind: 'tool-execution-start', frame: start } }
      : { fault: 'OMP RPC tool_execution_start frame was malformed' }
  }
  if (frame.type === 'tool_execution_update') {
    const update = parseOmpRpcToolExecutionUpdateFrame(frame)
    return update
      ? {
          event: {
            kind: 'tool-execution-update',
            frame: update,
            partialOutput: ompRpcToolResultDisplayOutput(update.partialResult)
          }
        }
      : { fault: 'OMP RPC tool_execution_update frame was malformed' }
  }
  if (frame.type === 'tool_execution_end') {
    const end = parseOmpRpcToolExecutionEndFrame(frame)
    return end
      ? {
          event: {
            kind: 'tool-execution-end',
            frame: end,
            output: ompRpcToolResultDisplayOutput(end.result),
            isError: end.isError === true
          }
        }
      : { fault: 'OMP RPC tool_execution_end frame was malformed' }
  }
  return null
}

export function resolveOmpRpcServerFrameEvent(
  frame: Record<string, unknown> & { type: string }
): OmpRpcServerFrameResolution {
  if (frame.type === 'available_commands_update') {
    try {
      return { event: { kind: 'commands', commands: parseOmpRpcCommands(frame.commands) } }
    } catch (error) {
      return { fault: error instanceof Error ? error.message : 'OMP RPC command catalog failed' }
    }
  }
  if (frame.type === 'command_output') {
    return typeof frame.text === 'string'
      ? { event: { kind: 'command-output', text: frame.text } }
      : { fault: 'OMP RPC command_output frame was malformed' }
  }
  if (frame.type === 'prompt_result') {
    if (
      typeof frame.agentInvoked !== 'boolean' ||
      (frame.id !== undefined && typeof frame.id !== 'string')
    ) {
      return { fault: 'OMP RPC prompt_result frame was malformed' }
    }
    return {
      event: {
        kind: 'prompt-result',
        id: frame.id as string | undefined,
        agentInvoked: frame.agentInvoked
      }
    }
  }
  if (frame.type === 'message_update') {
    const messageUpdate = parseOmpRpcMessageUpdateFrame(frame)
    return messageUpdate
      ? { event: { kind: 'message-update', frame: messageUpdate } }
      : { fault: 'OMP RPC message_update frame was malformed' }
  }
  if (frame.type === 'agent_end') {
    const agentEnd = parseOmpRpcAgentEndFrame(frame)
    return agentEnd
      ? { event: { kind: 'agent-end', frame: agentEnd } }
      : { fault: 'OMP RPC agent_end frame was malformed' }
  }
  if (frame.type === 'extension_ui_request') {
    const request = parseOmpRpcExtensionUiRequestFrame(frame)
    return request
      ? { event: { kind: 'extension-ui-request', frame: request } }
      : { fault: 'OMP RPC extension_ui_request frame was malformed' }
  }
  if (frame.type === 'recap_update') {
    if (frame.recap === null) {
      return { event: { kind: 'recap-update', recap: null } }
    }
    const recap = parseOmpRpcRecap(frame.recap)
    return recap
      ? { event: { kind: 'recap-update', recap } }
      : { fault: 'OMP RPC recap_update frame was malformed' }
  }
  if (frame.type === 'session_info_update') {
    const sessionInfo = parseOmpRpcSessionInfoUpdateFrame(frame)
    return sessionInfo
      ? {
          event: {
            kind: 'session-info',
            title: sessionInfo.title ?? null,
            sessionId: sessionInfo.sessionId ?? null
          }
        }
      : { fault: 'OMP RPC session_info_update frame was malformed' }
  }
  if (frame.type === 'config_update') {
    const config = parseOmpRpcConfigUpdateFrame(frame)
    return config
      ? {
          event: {
            kind: 'config-update',
            model: config.model ?? null,
            thinkingLevel: config.thinkingLevel ?? null
          }
        }
      : { fault: 'OMP RPC config_update frame was malformed' }
  }
  const toolExecution = resolveToolExecutionFrameEvent(frame)
  if (toolExecution) {
    return toolExecution
  }
  const subagent = resolveSubagentFrameEvent(frame)
  if (subagent) {
    return subagent
  }
  if (isOmpRpcSessionEventFrame(frame)) {
    return { event: { kind: 'session-event', frame } }
  }
  const passthroughKind = PASSTHROUGH_FRAME_KINDS[frame.type]
  if (!passthroughKind) {
    return null
  }
  // Why: rpc.md names these frame types but does not spell out their full
  // field shape (D3 floor) — forward the parsed object as-is.
  return { event: { kind: passthroughKind, frame } as OmpRpcClientEvent }
}
