import type { Socket } from 'node:net'
import type { RuntimePortForward } from '../../shared/runtime-port-forwards'
import type { BrowserNetworkTunnelDuplex } from '../browser/network/tunnels/browser-network-tunnel-duplex'
import { pipeUpstreamToClient } from '../browser/network/tunnels/remote-browser-socks-upstream'

/**
 * Joins a local connection to its tunnel stream and counts its bytes into the forward's state.
 * A host-side failure before any reply (the destination refused or timed out; with early data the
 * stream opened before the host knew) becomes the forward's lastError, cleared by the next reply.
 * A local app that hangs up first (a canceled browser preconnect) retires the stream without an
 * error, so it never shows as a host failure.
 */
export function pipeForwardedConnection(
  socket: Socket,
  remote: BrowserNetworkTunnelDuplex,
  state: Pick<RuntimePortForward, 'bytesToHost' | 'bytesFromHost' | 'lastError'>,
  on: { sent: (bytes: number) => void; changed: () => void }
): void {
  let replied = false
  socket.on('data', (chunk: Buffer) => {
    state.bytesToHost += chunk.byteLength
    on.sent(chunk.byteLength)
  })
  remote.on('data', (chunk: Buffer) => {
    state.bytesFromHost += chunk.byteLength
    if (!replied) {
      replied = true
      if (state.lastError !== undefined) {
        delete state.lastError
        on.changed()
      }
    }
  })
  socket.pipe(remote)
  // Settles each chunk once the local socket took it, which returns flow-control credit to the host.
  pipeUpstreamToClient(remote, socket)
  remote.on('error', (error: Error) => {
    // Only this stream's destination failing: a whole tunnel closing (VM asleep) is no port error.
    if (!replied && error.message.startsWith('Browser tunnel destination')) {
      state.lastError = error.message
      on.changed()
    }
    socket.destroy()
  })
  socket.on('close', () => remote.destroy())
  remote.on('close', () => socket.destroy())
  socket.resume()
}
