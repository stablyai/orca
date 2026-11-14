import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ID, subscribeFrame } from './bridge-host-test-harness'
import { BRIDGE_MAX_UNACKED_FRAMES } from './bridge-host-subscriptions'
import type { TerminalBacklogTimers } from './bridge-terminal-output-backlog'

const HELD_OUTPUT = { type: 'data', streamId: 1, chunk: 'h'.repeat(48 * 1024) }

function manualTimers(): TerminalBacklogTimers & {
  pending: () => number
  delays: number[]
  fire: () => void
} {
  const handlers = new Map<unknown, () => void>()
  const delays: number[] = []
  let nextHandle = 0
  return {
    set: (handler, ms) => {
      nextHandle += 1
      handlers.set(nextHandle, handler)
      delays.push(ms)
      return nextHandle
    },
    clear: (handle) => {
      handlers.delete(handle)
    },
    pending: () => handlers.size,
    delays,
    fire: () => {
      for (const [handle, handler] of handlers) {
        handlers.delete(handle)
        handler()
      }
    }
  }
}

function emitWindowAndHold(onData: (payload: unknown) => void): void {
  for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES; index += 1) {
    onData({ type: 'data', streamId: 1, chunk: String(index) })
  }
  onData(HELD_OUTPUT)
}

afterEach(() => vi.restoreAllMocks())

describe('bridge subscription start cleanup', () => {
  it('answers the original failure and leaves a same-ID replacement alive past the old deadline', () => {
    const client = createFakeRpcClient()
    const timers = manualTimers()
    let starts = 0
    const bridge = harness({
      ready: true,
      terminalTimers: timers,
      client: {
        ...client,
        subscribe: (method, params, onData, options) => {
          starts += 1
          if (starts === 1) {
            emitWindowAndHold(onData)
            throw new Error('failed after output')
          }
          return client.subscribe(method, params, onData, options)
        }
      }
    })

    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.last()).toMatchObject({ type: 'error', id: ID })
    bridge.host.receive(subscribeFrame(ID))
    expect(client.streams).toHaveLength(1)
    timers.fire()
    expect(client.streams[0]?.unsubscribes).toBe(0)
    client.streams[0]?.emit({ type: 'data', streamId: 2, chunk: 'replacement still live' })
    expect(bridge.last()).toEqual({
      v: 1,
      type: 'event',
      id: ID,
      seq: 1,
      payload: { type: 'data', streamId: 2, chunk: 'replacement still live' }
    })
    expect(bridge.frames().filter((frame) => frame.type === 'end')).toEqual([])
    bridge.host.dispose()
    expect(client.streams[0]?.unsubscribes).toBe(1)
  })
})
