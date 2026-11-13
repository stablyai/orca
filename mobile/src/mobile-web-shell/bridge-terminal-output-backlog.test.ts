import { describe, expect, it } from 'vitest'

import { clientFrame } from './bridge-host-test-fakes'
import { harness, ID } from './bridge-host-test-harness'

describe('the cases the rulings name', () => {
  function subscribed(ids: readonly string[]): ReturnType<typeof harness> {
    const bridge = harness({
      ready: true,
      terminalTimers: { set: () => 1, clear: () => undefined }
    })
    for (const id of ids) {
      bridge.host.receive(
        clientFrame({ type: 'subscribe', id, method: 'terminal.subscribe', params: {} })
      )
    }
    return bridge
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
