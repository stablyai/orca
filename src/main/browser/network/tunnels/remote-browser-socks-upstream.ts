import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export function pipeUpstreamToClient(upstream: Duplex, socket: Socket): void {
  upstream.on('data', (chunk: Buffer) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const accepted = socket.write(bytes, (error) => {
      if (!error && 'settleRead' in upstream && typeof upstream.settleRead === 'function') {
        upstream.settleRead(bytes.byteLength)
      }
    })
    if (!accepted) {
      upstream.pause()
    }
  })
  socket.on('drain', () => upstream.resume())
  upstream.once('end', () => socket.end())
}
