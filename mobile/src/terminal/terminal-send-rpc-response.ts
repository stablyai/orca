import type { RpcResponse } from '../transport/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The same verdict read off an admitted payload, for a call site that sends through an operation. */
export function isTerminalSendResultAccepted(result: unknown): boolean {
  return isRecord(result) && isRecord(result.send) && result.send.accepted === true
}

export function isTerminalSendRpcAccepted(response: RpcResponse): boolean {
  return response.ok && isTerminalSendResultAccepted(response.result)
}
