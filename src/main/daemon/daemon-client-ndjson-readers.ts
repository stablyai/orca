import { DaemonTransientReader } from './daemon-transient-reader'
import type { DaemonHelloOutcome } from './daemon-client-hello-handshake'
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
): TurnBoundedSocketReader {
  if (streamFraming === BINARY_STREAM_FRAMING) {
    const reader = createBinaryStreamFrameReader(onEvent, (error) => socket.destroy(error))
    return attachTurnBoundedSocketReader(socket, (chunk) => reader.feed(chunk), remainder)
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
  return attachTurnBoundedSocketReader(
    socket,
    (chunk) => parser.feed(decoder.write(chunk)),
    remainder
  )
}

export function attachTransientStreamReader(
  socket: Socket,
  hello: DaemonHelloOutcome,
  emit: (event: DaemonEvent) => void,
  resolveSession?: (incarnationId: string) => string | undefined
): { transientReader: DaemonTransientReader | undefined; streamReader: TurnBoundedSocketReader } {
  const transientReader = hello.transientStreamId
    ? new DaemonTransientReader(hello.transientStreamId, emit, resolveSession)
    : undefined
  const streamReader = attachStreamEventReader(socket, hello, (event) => {
    if (transientReader) {
      transientReader.accept(event)
    } else {
      emit(event)
    }
  })
  return { transientReader, streamReader }
}
