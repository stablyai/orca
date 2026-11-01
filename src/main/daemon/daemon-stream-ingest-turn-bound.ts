import type { Socket } from 'node:net'
import { yieldToEventLoop } from '../../shared/event-loop-yield'

export const STREAM_INGEST_TURN_BYTES = 64 * 1024

export type TurnBoundedSocketReader = {
  detach(): void
  /** Finish once bytes already buffered in this process have been consumed. */
  drainBuffered(done: () => void): void
}

/** Yield during output floods so commands and IPC run without losing stream ordering or backpressure. */
export function attachTurnBoundedSocketReader(
  socket: Socket,
  consume: (chunk: Buffer) => void,
  remainder: Buffer
): TurnBoundedSocketReader {
  let turnBytes = 0
  let turnEndPending = false
  let paused = false
  let detached = false
  let consumedBytes = 0
  let drainWaiters: { untilBytes: number; done: () => void }[] = []

  const releaseDrainWaiters = (): void => {
    // Why: runs per socket read and waiters exist only during disconnect; skip the filter allocation.
    if (drainWaiters.length === 0) {
      return
    }
    const ready = drainWaiters.filter((waiter) => consumedBytes >= waiter.untilBytes)
    if (ready.length === 0) {
      return
    }
    drainWaiters = drainWaiters.filter((waiter) => !ready.includes(waiter))
    for (const waiter of ready) {
      waiter.done()
    }
  }

  const endTurn = (): void => {
    turnEndPending = false
    turnBytes = 0
    if (paused && !detached) {
      paused = false
      socket.resume()
    }
  }

  const onData = (chunk: Buffer): void => {
    turnBytes += chunk.length
    if (!turnEndPending) {
      turnEndPending = true
      void yieldToEventLoop().then(endTurn)
    }
    if (turnBytes >= STREAM_INGEST_TURN_BYTES && !paused) {
      paused = true
      socket.pause()
    }
    consume(chunk)
    consumedBytes += chunk.length
    releaseDrainWaiters()
  }

  socket.on('data', onData)
  // Resume first so a remainder that fills this turn can leave the socket paused.
  socket.resume()
  if (remainder.length > 0) {
    onData(remainder)
  }
  return {
    detach: () => {
      detached = true
      drainWaiters = []
      socket.off('data', onData)
    },
    drainBuffered: (done) => {
      if (detached || socket.destroyed || socket.readableLength === 0) {
        done()
        return
      }
      // Account for unread process-local bytes so pausing cannot skip them during drain.
      drainWaiters.push({ untilBytes: consumedBytes + socket.readableLength, done })
    }
  }
}
