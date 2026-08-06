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
