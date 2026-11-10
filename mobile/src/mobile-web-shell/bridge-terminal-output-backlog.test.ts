import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'

import { clientFrame } from './bridge-host-test-fakes'
import { harness, ID, OTHER } from './bridge-host-test-harness'

import type { TerminalBacklogTimers } from './bridge-terminal-output-backlog'

// Rebuild measured terminal timing: host JSON at 70.3 MiB/s, xterm at 2.2 MiB/s, batcher 64 KiB/5 ms and chunker 48 KiB; a 5 MB cat exhausts the ordinary window before paint.
// Measure JSON expansion for ASCII and SGR output; simulate the timeline because the original design capture files are not in this lane.

function manualTimers(): TerminalBacklogTimers & { fire: () => void; armed: () => boolean } {
  let handler: (() => void) | null = null
  return {
    set: (next) => {
      handler = next
      return 1
    },
    clear: () => {
      handler = null
    },
    armed: () => handler !== null,
    fire: () => {
      const pending = handler
      handler = null
      pending?.()
    }
  }
}

// Simulate emit → limited page drain → interval acknowledgement at measured rates; this ordering determines whether backpressure kills the stream.

describe('the two ends a held terminal stream has', () => {
  function held(): ReturnType<typeof harness> & { timers: ReturnType<typeof manualTimers> } {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'terminal.subscribe', params: {} })
    )
    return Object.assign(bridge, { timers })
  }

  it('still ends on one event over the frame cap, which is C0.3 and is not slowness', () => {
    // Holding cannot rescue an event the page refuses for size; the frame cap still ends it visibly.
    const bridge = held()
    bridge.client.streams[0].emit({
      type: 'data',
      streamId: 1,
      chunk: 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1)
    })
    const ends = bridge.frames().filter((frame) => frame.type === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'overflow' })
  })
})

describe('the cases the rulings name', () => {
  function subscribed(
    ids: readonly string[]
  ): ReturnType<typeof harness> & { timers: ReturnType<typeof manualTimers> } {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    for (const id of ids) {
      bridge.host.receive(
        clientFrame({ type: 'subscribe', id, method: 'terminal.subscribe', params: {} })
      )
    }
    return Object.assign(bridge, { timers })
  }

  // Close the frame-count window cheaply; 256 small frames exercise the same held state without allocating a 4 MiB byte-window fixture.
  const SMALL_CHUNK = 'x'.repeat(1024)
  const OVER_FRAME_WINDOW = 300

  function drain(bridge: ReturnType<typeof harness>, id: string): void {
    for (let pass = 0; pass < 2_000; pass += 1) {
      const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === id)
      const last = events.at(-1)
      if (last === undefined || last.type !== 'event') {
        return
      }
      const before = bridge.frames().length
      bridge.host.receive(clientFrame({ type: 'ack', id, seq: last.seq }))
      if (bridge.frames().length === before) {
        return
      }
    }
  }

  it('keeps one backlog per subscription, so a busy terminal cannot end a quiet one', () => {
    const bridge = subscribed([ID, OTHER])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.client.streams[1].emit({ type: 'data', streamId: 2, chunk: 'quiet' })
    const other = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === OTHER)
    expect(other).toHaveLength(1)
    expect(bridge.frames().some((frame) => frame.type === 'end' && frame.id === OTHER)).toBe(false)
  })

  it('breaks a merge run on a payload that is not output, and keeps the order', () => {
    // Merge only consecutive output; resize/metadata must retain their position between byte runs.
    const bridge = subscribed([ID])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.client.streams[0].emit({ type: 'resized', streamId: 1, cols: 80, rows: 24 })
    bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: 'after-the-resize' })
    drain(bridge, ID)
    const payloads = bridge
      .frames()
      .flatMap((frame) => (frame.type === 'event' && 'payload' in frame ? [frame.payload] : []))
    const resizeAt = payloads.findIndex(
      (payload) =>
        typeof payload === 'object' &&
        payload !== null &&
        'type' in payload &&
        payload.type === 'resized'
    )
    expect(resizeAt).toBeGreaterThan(0)
    expect(payloads[resizeAt]).toEqual({ type: 'resized', streamId: 1, cols: 80, rows: 24 })
    const before = payloads
      .slice(0, resizeAt)
      .map((payload) => {
        if (typeof payload !== 'object' || payload === null || !('chunk' in payload)) {
          throw new Error('missing pre-resize output')
        }
        return payload.chunk
      })
      .join('')
    expect(before).toBe(SMALL_CHUNK.repeat(OVER_FRAME_WINDOW))
    expect(payloads.slice(resizeAt + 1)).toEqual([
      { type: 'data', streamId: 1, chunk: 'after-the-resize' }
    ])
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
  })
})
