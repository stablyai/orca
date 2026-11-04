import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

export function createBrowserNetworkTunnelStream(options: {
  id: number
  socket: BrowserNetworkTunnelSocket
  onConnectTimeout: (stream: BrowserNetworkTunnelStream) => void
}): BrowserNetworkTunnelStream {
  const stream: BrowserNetworkTunnelStream = {
    id: options.id,
    socket: options.socket,
    connected: false,
    closed: false,
    // Granted at connect alongside the initial WindowUpdate; tracking must match the announcement.
    receiveCredit: 0,
    sendCredit: 0,
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
  releaseRetainedBytes: (bytes: number) => void
): void {
  if (stream.closed) {
    return
  }
  stream.closed = true
  clearTimeout(stream.connectTimeout)
  for (const release of stream.pendingDestinationWriteReleases) {
    release()
  }
  releaseRetainedBytes(stream.pendingToClientBytes)
  stream.pendingToClient = []
  stream.pendingToClientBytes = 0
  stream.socket.destroy()
}
