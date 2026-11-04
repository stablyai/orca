import { buildDirectRpcWireRequest, type RpcRequestFrame } from './rpc-envelope-fields'
import type { RpcClientSocketSession } from './rpc-client-socket-session'
import type { ConnectionState } from './types'

export function sendDirectRpcFrame(
  session: RpcClientSocketSession | null,
  frame: RpcRequestFrame,
  deviceToken: string,
  capacity: number,
  state: ConnectionState
): boolean {
  if (session) {
    return session.sendEncrypted(buildDirectRpcWireRequest(frame, deviceToken), capacity)
  }
  console.log('[net] sendEncrypted FAILED — channel not ready', {
    hasWs: false,
    hasKey: false,
    state
  })
  return false
}
