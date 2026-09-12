import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'
import {
  BrowserNetworkTunnelOpcode,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'

export function markBrowserNetworkTunnelConnected(
  stream: BrowserNetworkTunnelStream,
  sender: BrowserNetworkTunnelFrameSender
): void {
  if (stream.connected) {
    return
  }
  stream.connected = true
  stream.releasePendingOpen()
  clearTimeout(stream.connectTimeout)
  sender.send(BrowserNetworkTunnelOpcode.Opened, stream.id)
  sender.send(
    BrowserNetworkTunnelOpcode.WindowUpdate,
    stream.id,
    encodeBrowserNetworkTunnelWindowUpdate(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
  )
}

export function markBrowserNetworkTunnelDestinationEnd(
  stream: BrowserNetworkTunnelStream
): string | null {
  if (!stream.connected) {
    return 'destination_closed_before_connect'
  }
  if (stream.destinationEnded) {
    return 'duplicate_destination_half_close'
  }
  stream.destinationEnded = true
  return null
}

export function createBrowserNetworkTunnelStream(options: {
  id: number
  socket: BrowserNetworkTunnelSocket
  releasePendingOpen: () => void
  onConnectTimeout: (stream: BrowserNetworkTunnelStream) => void
}): BrowserNetworkTunnelStream {
  const stream: BrowserNetworkTunnelStream = {
    id: options.id,
    socket: options.socket,
    connected: false,
    releasePendingOpen: options.releasePendingOpen,
    closed: false,
    receiveCredit: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    sendCredit: 0,
    initialClientCreditReceived: false,
    unsettledDestinationBytes: 0,
    flushingToClient: false,
    pendingToClient: [],
    pendingToClientBytes: 0,
    pendingDestinationWriteReleases: new Set(),
    clientEnded: false,
    destinationEnded: false,
    destinationClosed: false,
    destinationHalfCloseSent: false,
    connectTimeout: setTimeout(
      () => options.onConnectTimeout(stream),
      BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    )
  }
  return stream
}

export function retireBrowserNetworkTunnelStream(
  stream: BrowserNetworkTunnelStream,
  releaseRetainedBytes: (bytes: number) => void,
  onDiscardedData?: () => void
): void {
  if (stream.closed) {
    return
  }
  if (
    stream.pendingToClientBytes > 0 ||
    stream.pendingDestinationWriteReleases.size > 0 ||
    stream.unsettledDestinationBytes > 0
  ) {
    onDiscardedData?.()
  }
  stream.closed = true
  clearTimeout(stream.connectTimeout)
  stream.releasePendingOpen()
  for (const release of stream.pendingDestinationWriteReleases) {
    release()
  }
  releaseRetainedBytes(stream.pendingToClientBytes)
  stream.pendingToClient = []
  stream.pendingToClientBytes = 0
  stream.socket.destroy()
}
