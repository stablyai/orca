import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { armDaemonSocketCloseHandlers } from './daemon-client-socket-connect'
import {
  attachTurnBoundedSocketReader,
  STREAM_INGEST_TURN_BYTES
} from './daemon-stream-ingest-turn-bound'

const CHUNK_BYTES = STREAM_INGEST_TURN_BYTES / 2
const CHUNK_COUNT = 8

function bufferedSocket(): Socket {
  const socket = new Socket()
  for (let index = 0; index < CHUNK_COUNT; index++) {
    socket.push(Buffer.alloc(CHUNK_BYTES, index))
  }
  socket.push(null)
  return socket
}

const nextTick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve))

describe('attachTurnBoundedSocketReader', () => {
  it('handles a control close only after the stream bytes already read are consumed', async () => {
    const stream = bufferedSocket()
    const control = new Socket()
    const seen: number[] = []
    const reader = attachTurnBoundedSocketReader(
      stream,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(0)
    )
    const onClose = vi.fn(() => seen.push(-2))
    armDaemonSocketCloseHandlers(control, stream, onClose, reader.drainBuffered)
    await nextTick()
    expect(stream.isPaused()).toBe(true)

    control.destroy()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(seen.slice(0, CHUNK_COUNT + 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, -2])
    stream.destroy()
  })
})
