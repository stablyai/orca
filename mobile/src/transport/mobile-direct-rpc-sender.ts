import type { MobileDirectRpcOutbound } from './mobile-direct-rpc-outbound'
import { stringifyMobileOutboundJson } from './mobile-outbound-json'
import type { ConnectionState } from './types'

export function createMobileDirectRpcSender(args: {
  getOutbound: () => MobileDirectRpcOutbound | null
  getSharedKey: () => Uint8Array | null
  getSocket: () => WebSocket | null
  getState: () => ConnectionState
  onSocketDesync: (socket: WebSocket) => void
}): (request: unknown) => boolean {
  return (request): boolean => {
    const socket = args.getSocket()
    const sharedKey = args.getSharedKey()
    const outbound = args.getOutbound()
    if (socket && socket.readyState === WebSocket.OPEN && sharedKey && outbound) {
      try {
        return outbound.enqueue(
          stringifyMobileOutboundJson(request),
          sharedKey,
          requestAcknowledgementKey(request)
        )
      } catch (error) {
        console.warn('[net] outbound request rejected', error)
        return false
      }
    }
    const state = args.getState()
    console.log('[net] sendEncrypted FAILED — channel not ready', {
      hasWs: !!socket,
      readyState: socket?.readyState,
      hasKey: !!sharedKey,
      state
    })
    if (state === 'connected' && socket && socket.readyState !== WebSocket.OPEN) {
      console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
        readyState: socket.readyState
      })
      args.onSocketDesync(socket)
    }
    return false
  }
}

function requestAcknowledgementKey(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') {
    return undefined
  }
  const id = (request as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}
