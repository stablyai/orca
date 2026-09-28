import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createNdjsonParser } from './ndjson'
import type { DaemonEvent, RpcResponse } from './types'

export function attachControlResponseReader(
  socket: Duplex,
  onResponse: (response: RpcResponse) => void
): () => void {
  // Why: control responses may contain terminal/startup data with multibyte
  // text; keep incomplete UTF-8 bytes until the next socket chunk.
  const decoder = new StringDecoder('utf8')
  const parser = createNdjsonParser(
    (msg) => onResponse(msg as RpcResponse),
    () => {} // Ignore parse errors on control socket
  )

  const onData = (chunk: Buffer) => parser.feed(decoder.write(chunk))
  socket.on('data', onData)
  socket.resume()
  return () => socket.off('data', onData)
}

export function attachStreamEventReader(
  socket: Duplex,
  onEvent: (event: DaemonEvent) => void
): () => void {
  // Why: PTY output streams include emoji/box-drawing tables; socket chunks
  // can split those UTF-8 sequences across packets.
  const decoder = new StringDecoder('utf8')
  const parser = createNdjsonParser(
    (msg) => {
      const event = msg as DaemonEvent
      if (event.type === 'event') {
        onEvent(event)
      }
    },
    () => {} // Ignore parse errors on stream socket
  )

  const onData = (chunk: Buffer) => parser.feed(decoder.write(chunk))
  socket.on('data', onData)
  socket.resume()
  return () => socket.off('data', onData)
}
