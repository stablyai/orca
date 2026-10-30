import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { createNdjsonParser } from './ndjson'
import {
  BINARY_STREAM_FRAMING,
  createBinaryStreamFrameReader,
  type DaemonStreamFraming
} from './daemon-stream-binary-framing'
import {
  attachTurnBoundedSocketReader,
  type TurnBoundedSocketReader
} from './daemon-stream-ingest-turn-bound'
import type { DaemonEvent, RpcResponse } from './types'

export function attachControlResponseReader(
  socket: Socket,
  onResponse: (response: RpcResponse) => void,
  remainder: Buffer = Buffer.alloc(0)
): () => void {
  // Preserve multibyte UTF-8 sequences split across socket chunks.
  const decoder = new StringDecoder('utf8')
  const parser = createNdjsonParser(
    (msg) => onResponse(msg as RpcResponse),
    () => {}
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
): TurnBoundedSocketReader {
  if (streamFraming === BINARY_STREAM_FRAMING) {
    const reader = createBinaryStreamFrameReader(onEvent, (error) => socket.destroy(error))
    return attachTurnBoundedSocketReader(socket, (chunk) => reader.feed(chunk), remainder)
  }
  // PTY output can split multibyte UTF-8 sequences across socket chunks.
  const decoder = new StringDecoder('utf8')
  const parser = createNdjsonParser(
    (msg) => {
      const event = msg as DaemonEvent
      if (event.type === 'event') {
        onEvent(event)
      }
    },
    () => {}
  )
  return attachTurnBoundedSocketReader(
    socket,
    (chunk) => parser.feed(decoder.write(chunk)),
    remainder
  )
}
