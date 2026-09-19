import type { BrowserNetworkTunnelClientStream } from './browser-network-tunnel-client-stream'

export function completeBrowserNetworkTunnelClientStream(
  stream: BrowserNetworkTunnelClientStream,
  retire: (stream: BrowserNetworkTunnelClientStream) => void
): void {
  if (
    !stream.closed &&
    (stream.remoteClosed || (stream.localHalfCloseSent && stream.remoteEnded)) &&
    stream.socket.readableEnded &&
    stream.socket.writableFinished &&
    stream.pendingWrites.length === 0 &&
    stream.pendingToSocket.length === 0 &&
    stream.unsettledToSocket.length === 0
  ) {
    if (stream.remoteClosed) {
      retire(stream)
    } else {
      stream.socket.destroy()
    }
  }
}

export function observeBrowserNetworkTunnelClientCompletion(
  stream: BrowserNetworkTunnelClientStream,
  retire: (stream: BrowserNetworkTunnelClientStream) => void
): void {
  const complete = () => completeBrowserNetworkTunnelClientStream(stream, retire)
  stream.socket.once('end', complete)
  stream.socket.once('finish', complete)
}

export function retireBrowserNetworkTunnelClientStream(
  stream: BrowserNetworkTunnelClientStream,
  options: {
    error?: Error
    destroySocket: boolean
    remove: () => void
    onFailure?: (error: Error) => void
  }
): void {
  if (stream.closed) {
    return
  }
  if (options.error) {
    options.onFailure?.(options.error)
  } else if (
    stream.pendingWrites.length ||
    stream.pendingToSocket.length ||
    stream.unsettledToSocket.length ||
    stream.socket.writableLength
  ) {
    options.onFailure?.(new Error('browser_tunnel_retired_unsettled_data'))
  }
  stream.closed = true
  clearTimeout(stream.connectTimeout)
  options.remove()
  if (!stream.opened) {
    stream.rejectOpen(
      options.error ?? new Error('Browser tunnel destination closed before opening')
    )
  }
  const pendingWrites = stream.pendingWrites
  const writeError = options.error ?? new Error('Browser tunnel stream closed')
  for (const pending of pendingWrites) {
    pending.releaseApplicationBytes()
  }
  for (const pending of stream.pendingToSocket) {
    pending.releaseApplicationBytes()
  }
  for (const settlement of stream.unsettledToSocket) {
    settlement.releaseApplicationBytes()
  }
  stream.pendingWrites = []
  stream.pendingWriteBytes = 0
  stream.pendingToSocket = []
  stream.pendingToSocketBytes = 0
  stream.unsettledToSocket = []
  try {
    for (const pending of pendingWrites) {
      pending.callback(writeError)
    }
  } finally {
    if (options.destroySocket && !stream.socket.destroyed) {
      stream.socket.destroy(options.error)
    }
  }
}
