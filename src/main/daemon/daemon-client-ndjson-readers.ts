import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { createNdjsonParser } from './ndjson'
import {
  BINARY_STREAM_FRAMING,
  createBinaryStreamFrameReader,
  type DaemonStreamFraming
} from './daemon-stream-binary-framing'
import type { DaemonEvent, RpcResponse } from './types'

export function attachControlResponseReader(
  socket: Socket,
  onResponse: (response: RpcResponse) => void,
  remainder: Buffer = Buffer.alloc(0)
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
  onData(remainder)
  socket.resume()
  return () => socket.off('data', onData)
}

export type StreamEventReaderFraming = {
  streamFraming: DaemonStreamFraming
  /** Stream bytes the hello reader already received past its line. */
  remainder: Buffer
}

export function attachStreamEventReader(
  socket: Socket,
  { streamFraming, remainder }: StreamEventReaderFraming,
  onEvent: (event: DaemonEvent) => void
): () => void {
  if (streamFraming === BINARY_STREAM_FRAMING) {
    const reader = createBinaryStreamFrameReader(onEvent, (error) => socket.destroy(error))
    const onFrameData = (chunk: Buffer) => reader.feed(chunk)
    socket.on('data', onFrameData)
    reader.feed(remainder)
    socket.resume()
    return () => socket.off('data', onFrameData)
  }
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
  onData(remainder)
  socket.resume()
  return () => socket.off('data', onData)
}
