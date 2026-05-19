import type { Socket } from 'net'
import { vi } from 'vitest'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'

export function parseWrite(call: unknown[]): unknown {
  return JSON.parse(String(call[0]).trim())
}

export function createFakeSocket(writeResults: boolean[] = [true]): {
  socket: Socket
  write: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  drain: () => void
  close: () => void
  error: () => void
  staleDrain: () => void
  staleClose: () => void
  staleError: () => void
} {
  let drainHandler: (() => void) | null = null
  let closeHandler: (() => void) | null = null
  let errorHandler: (() => void) | null = null
  let removedDrainHandler: (() => void) | null = null
  let removedCloseHandler: (() => void) | null = null
  let removedErrorHandler: (() => void) | null = null
  const write = vi.fn(() => writeResults.shift() ?? true)
  const removeListener = vi.fn((event: string, handler: () => void) => {
    if (event === 'drain' && drainHandler === handler) {
      removedDrainHandler = handler
      drainHandler = null
    } else if (event === 'close' && closeHandler === handler) {
      removedCloseHandler = handler
      closeHandler = null
    } else if (event === 'error' && errorHandler === handler) {
      removedErrorHandler = handler
      errorHandler = null
    }
    return socket
  })
  const socket = {
    destroyed: false,
    write,
    removeListener,
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'drain') {
        drainHandler = handler
      } else if (event === 'close') {
        closeHandler = handler
      } else if (event === 'error') {
        errorHandler = handler
      }
      return socket
    })
  } as unknown as Socket

  return {
    socket,
    write,
    removeListener,
    drain: () => drainHandler?.(),
    close: () => closeHandler?.(),
    error: () => errorHandler?.(),
    staleDrain: () => removedDrainHandler?.(),
    staleClose: () => removedCloseHandler?.(),
    staleError: () => removedErrorHandler?.()
  }
}

export function createHarness(writeResults: boolean[] = [true]) {
  let now = 0
  const fake = createFakeSocket(writeResults)
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }), {
    now: () => now
  })

  return {
    batcher,
    fake,
    setNow(value: number) {
      now = value
    }
  }
}
