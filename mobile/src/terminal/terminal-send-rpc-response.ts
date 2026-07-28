import type { RpcResponse } from '../transport/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isTerminalSendRpcAccepted(response: RpcResponse): boolean {
  if (!response.ok) {
    return false
  }
  if (!isRecord(response.result) || !isRecord(response.result.send)) {
    return false
  }
  return response.result.send.accepted === true
}

export function getTerminalInputQueueRpcOutcome(
  response: RpcResponse,
  expected: { readonly id: string; readonly sequence: number }
): 'accepted' | 'rejected' | 'unacknowledged' {
  if (!response.ok || !isRecord(response.result) || !isRecord(response.result.send)) {
    return 'unacknowledged'
  }
  const acknowledgement = response.result.send.inputQueue
  if (
    !isRecord(acknowledgement) ||
    acknowledgement.id !== expected.id ||
    acknowledgement.sequence !== expected.sequence
  ) {
    return 'unacknowledged'
  }
  return response.result.send.accepted === true ? 'accepted' : 'rejected'
}
