import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// A connect the OS finished during a freeze, delivered after the next timers phase (Windows waits
// for a free pipe instance off the loop and hands the result back later).
vi.mock('node:net', () => ({
  connect: () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in for the mocked connect; connectDaemonSocket only listens for its events and calls destroy.
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean }
    socket.destroyed = false
    socket.destroy = () => {
      socket.destroyed = true
    }
    setImmediate(() => socket.emit('connect'))
    return socket
  }
}))

const { connectDaemonSocket } = await import('./daemon-client-socket-connect')

function freeze(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // busy wait, as a synchronous spawn blocks
  }
}

describe('daemon connect across a main-process freeze', () => {
  it('keeps a connection that completed while main was frozen', async () => {
    await new Promise((resolve) => setImmediate(resolve))
    const pending = connectDaemonSocket('orca-freeze-test-pipe', 300)
    freeze(900)
    const socket = await pending
    expect(socket.destroyed).toBe(false)
  })
})
