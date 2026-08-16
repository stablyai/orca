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
  for (const pending of stream.pendingWrites) {
    pending.callback(options.error ?? new Error('Browser tunnel stream closed'))
  }
  stream.pendingWrites = []
  stream.pendingWriteBytes = 0
  stream.pendingToSocket = []
  stream.pendingToSocketBytes = 0
  if (options.destroySocket && !stream.socket.destroyed) {
    stream.socket.destroy(options.error)
  }
}
