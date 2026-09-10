import type { OmpRpcPendingResponse } from './omp-rpc-command-correlation'
import { OmpRpcCommandError, settleOmpRpcPendingResponse } from './omp-rpc-command-correlation'
import { isOmpRpcObject } from './omp-rpc-frame-validation'
import { OMP_RPC_PROTOCOL_VERSION } from './omp-rpc-transport-limits'

type OmpRpcResponseFrame = Record<string, unknown>

export type OmpRpcResponseResolution =
  | { kind: 'handled' }
  | { kind: 'response'; pending: OmpRpcPendingResponse; frame: OmpRpcResponseFrame }

function waitsForTurnTerminal(command: OmpRpcPendingResponse['command']): boolean {
  return command === 'prompt'
}

function settleTurnIfComplete(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  id: string,
  pending: OmpRpcPendingResponse
): void {
  if (!pending.hasAcknowledged || !pending.hasTurnTerminal) {
    return
  }
  pendingResponses.delete(id)
  pending.resolve(
    pending.terminalAgentInvoked === undefined
      ? pending.acknowledgedData
      : { agentInvoked: pending.terminalAgentInvoked }
  )
}

export function settleOmpRpcTurnTerminal(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  frame: Record<string, unknown>
): void {
  const id = typeof frame.id === 'string' ? frame.id : undefined
  const matchingEntries: Iterable<[string, OmpRpcPendingResponse | undefined]> = id
    ? [[id, pendingResponses.get(id)]]
    : [...pendingResponses.entries()].filter(([, pending]) => waitsForTurnTerminal(pending.command))
  for (const [requestId, pending] of matchingEntries) {
    if (!pending || !waitsForTurnTerminal(pending.command)) {
      continue
    }
    pending.hasTurnTerminal = true
    pending.terminalAgentInvoked =
      typeof frame.agentInvoked === 'boolean' ? frame.agentInvoked : undefined
    settleTurnIfComplete(pendingResponses, requestId, pending)
  }
}

export function resolveOmpRpcResponseFrame(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  frame: OmpRpcResponseFrame,
  emitUnknownFrame: () => void
): OmpRpcResponseResolution {
  const id = typeof frame.id === 'string' ? frame.id : ''
  const pending = pendingResponses.get(id)
  if (!pending || pending.command !== frame.command) {
    emitUnknownFrame()
    return { kind: 'handled' }
  }
  if (waitsForTurnTerminal(pending.command)) {
    if (frame.success === true) {
      pending.acknowledgedData = frame.data
      pending.hasAcknowledged = true
      if (isOmpRpcObject(frame.data) && frame.data.agentInvoked === false) {
        pendingResponses.delete(id)
        pending.resolve({ agentInvoked: false })
        return { kind: 'handled' }
      }
      settleTurnIfComplete(pendingResponses, id, pending)
      return { kind: 'handled' }
    }
    pendingResponses.delete(id)
    pending.reject(
      new OmpRpcCommandError(
        typeof frame.error === 'string' ? frame.error : 'OMP RPC command failed',
        typeof frame.code === 'string' ? frame.code : undefined
      )
    )
    return { kind: 'handled' }
  }
  settleOmpRpcPendingResponse(pendingResponses, id, frame.command)
  return { kind: 'response', pending, frame }
}

export function handleOmpRpcResponseFrame(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  frame: OmpRpcResponseFrame,
  emitUnknownFrame: () => void,
  onProtocolNegotiated: () => void
): void {
  const resolution = resolveOmpRpcResponseFrame(pendingResponses, frame, emitUnknownFrame)
  if (resolution.kind === 'handled') {
    return
  }
  const { pending } = resolution
  if (resolution.frame.success === true) {
    if (pending.command === 'negotiate_protocol') {
      if (
        !isOmpRpcObject(resolution.frame.data) ||
        resolution.frame.data.protocolVersion !== OMP_RPC_PROTOCOL_VERSION
      ) {
        pending.reject(new Error('response did not select protocol v2'))
        return
      }
      onProtocolNegotiated()
    }
    pending.resolve(resolution.frame.data)
    return
  }
  pending.reject(
    new OmpRpcCommandError(
      typeof resolution.frame.error === 'string'
        ? resolution.frame.error
        : 'OMP RPC command failed',
      typeof resolution.frame.code === 'string' ? resolution.frame.code : undefined
    )
  )
}
