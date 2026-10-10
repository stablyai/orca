import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  decodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

// Aggregate retained-byte exhaustion, not a peer protocol violation: only the one stream fails.
export const BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW = 'route_buffer_overflow'

type BrowserNetworkTunnelDestinationFlowActions = {
  isCurrent: () => boolean
  sendData: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  sendHalfClose: () => void
  finalizeClose: () => void
  releaseRetainedBytes: (bytes: number) => void
}

export function halfCloseBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream
): string | null {
  if (!stream.connected || stream.clientEnded) {
    return 'invalid_client_half_close'
  }
  stream.clientEnded = true
  stream.socket.end()
  return null
}

export function writeBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream,
  payload: Uint8Array<ArrayBufferLike>,
  onSettled: (bytes: number) => void,
  claimRetainedBytes: (bytes: number) => (() => void) | null
): string | null {
  if (!stream.connected || stream.clientEnded) {
    return 'invalid_client_data'
  }
  if (payload.byteLength > stream.receiveCredit) {
    return 'receive_window_exceeded'
  }
  if (payload.byteLength === 0) {
    return null
  }
  if (
    stream.pendingDestinationWriteReleases.size >= BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
  ) {
    return 'destination_write_chunk_overflow'
  }
  const releaseClaim = claimRetainedBytes(payload.byteLength)
  if (!releaseClaim) {
    return BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW
  }
  stream.receiveCredit -= payload.byteLength
  const bytes = payload.slice()
  let retained = true
  const release = (): void => {
    if (!retained) {
      return
    }
    retained = false
    stream.pendingDestinationWriteReleases.delete(release)
    releaseClaim()
  }
  stream.pendingDestinationWriteReleases.add(release)
  stream.socket.write(bytes, () => {
    release()
    onSettled(bytes.byteLength)
  })
  return null
}

export function grantBrowserNetworkDestinationCredit(
  stream: BrowserNetworkTunnelStream,
  payload: Uint8Array<ArrayBufferLike>
): string | null {
  if (!stream.connected) {
    return 'invalid_client_credit'
  }
  const credit = decodeBrowserNetworkTunnelWindowUpdate(payload)
  if (!credit || stream.sendCredit + credit > BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES) {
    return 'send_window_overflow'
  }
  stream.sendCredit += credit
  return null
}

export function queueBrowserNetworkDestinationData(
  stream: BrowserNetworkTunnelStream,
  bytes: Uint8Array<ArrayBufferLike>
): string | null {
  if (!stream.connected || stream.destinationEnded || stream.destinationClosed) {
    return 'invalid_destination_data'
  }
  if (
    stream.pendingToClientBytes + bytes.byteLength >
      BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES ||
    stream.pendingToClient.length >= BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS
  ) {
    return 'destination_buffer_overflow'
  }
  stream.pendingToClient.push(bytes.slice())
  stream.pendingToClientBytes += bytes.byteLength
  return null
}

export function flushBrowserNetworkDestination(
  stream: BrowserNetworkTunnelStream,
  actions: BrowserNetworkTunnelDestinationFlowActions
): void {
  while (stream.sendCredit > 0 && stream.pendingToClient.length > 0 && actions.isCurrent()) {
    const next = stream.pendingToClient[0]!
    const length = Math.min(
      next.byteLength,
      stream.sendCredit,
      BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES
    )
    if (!actions.sendData(next.subarray(0, length))) {
      return
    }
    if (!actions.isCurrent()) {
      return
    }
    stream.sendCredit -= length
    stream.pendingToClientBytes -= length
    actions.releaseRetainedBytes(length)
    if (length === next.byteLength) {
      stream.pendingToClient.shift()
    } else {
      stream.pendingToClient[0] = next.slice(length)
    }
  }
  if (!actions.isCurrent()) {
    return
  }
  if (stream.pendingToClient.length > 0) {
    stream.socket.pause()
    return
  }
  if (stream.destinationEnded) {
    actions.sendHalfClose()
    if (!stream.destinationClosed) {
      return
    }
  }
  if (stream.destinationClosed) {
    actions.finalizeClose()
  } else if (stream.sendCredit === 0) {
    stream.socket.pause()
  } else {
    stream.socket.resume()
  }
}
