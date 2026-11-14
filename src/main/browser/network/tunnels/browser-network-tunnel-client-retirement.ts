import type { BrowserNetworkTunnelClientStream } from './browser-network-tunnel-client-stream'

export function retireBrowserNetworkTunnelClientStream(
  stream: BrowserNetworkTunnelClientStream,
  options: { error?: Error; destroySocket: boolean; remove: () => void }
): void {
  if (stream.closed) {
    return
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
