import type { ConnectionState } from '../transport/types'

export function mobileWebBridgeConnectionState(
  state: ConnectionState
): 'connecting' | 'connected' | 'offline' | 'recovering' {
  if (state === 'connected') {
    return 'connected'
  }
  if (state === 'reconnecting') {
    return 'recovering'
  }
  if (state === 'connecting' || state === 'handshaking') {
    return 'connecting'
  }
  return 'offline'
}
