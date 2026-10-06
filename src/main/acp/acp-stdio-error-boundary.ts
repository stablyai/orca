import type { Readable, Writable } from 'node:stream'

function ignoreLateError(): void {}

export function detachAcpStreamErrorHandler(
  stream: Readable | Writable,
  handler: (error: Error) => void
): void {
  stream.removeListener('error', handler)
  if (stream.closed) {
    return
  }
  // Node may emit the write error after its callback has already closed the peer.
  stream.on('error', ignoreLateError)
  stream.once('close', () => stream.removeListener('error', ignoreLateError))
}
