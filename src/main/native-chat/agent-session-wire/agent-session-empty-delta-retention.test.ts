import { describe, expect, it, vi } from 'vitest'
import { createCodexStructuredItemStreams } from '../../codex/codex-structured-item-streams'
import { createAgentSessionDeltaCoalescer } from './agent-session-delta-coalescer'

describe('empty streamed deltas', () => {
  it('does not retain empty array slots through repeated Codex publications', () => {
    const prefix = 'empty-delta-retention-prefix'
    const streams = createCodexStructuredItemStreams({
      sink: { appendItem() {}, appendTombstone() {}, publish() {} },
      identityFor: () => ({ provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }),
      schedule: () => () => {}
    })
    const append = (delta: string) =>
      streams.handle('thread', 'item/agentMessage/delta', { itemId: 'item', delta })
    append(prefix)
    try {
      for (let batch = 0; batch < 4; batch += 1) {
        for (let index = 0; index < 16_384; index += 1) {
          append('')
        }
        expect(streams.flush()).toBe(true)
      }
      const originalJoin = Array.prototype.join
      let retainedSlots = -1
      const spy = vi
        .spyOn(Array.prototype, 'join')
        .mockImplementation(function (this: unknown[], separator) {
          // Byte counters cannot detect empty entries retained by the stream's chunk array.
          if (separator === '' && this[0] === prefix) {
            retainedSlots = this.length
          }
          return originalJoin.call(this, separator)
        })
      let snapshot: ReturnType<typeof streams.snapshot>
      try {
        snapshot = streams.snapshot('thread', 'item')
      } finally {
        spy.mockRestore()
      }
      expect(retainedSlots).toBe(1)
      expect(snapshot).toEqual({
        text: prefix,
        observedBytes: Buffer.byteLength(prefix),
        truncated: false
      })
      append('é')
      expect(streams.snapshot('thread', 'item')?.text).toBe(`${prefix}é`)
      streams.forget('thread', 'item')
      expect(streams.snapshot('thread', 'item')).toBeNull()
    } finally {
      streams.dispose()
    }
  })

  it('preserves empty stream snapshots, scheduled publication and explicit flushes', () => {
    const pending = new Set<() => void>()
    const emitted: { key: string; text: string }[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: (run) => {
        pending.add(run)
        return () => {
          pending.delete(run)
        }
      },
      emit: (key, text) => emitted.push({ key, text })
    })
    try {
      expect(instance.append('empty', '')).toBe(true)
      expect(instance.snapshot('empty')).toEqual({
        text: '',
        observedBytes: 0,
        truncated: false
      })
      expect(pending.size).toBe(1)
      expect(emitted).toEqual([])
      expect(instance.flushAll()).toBe(true)
      expect(pending.size).toBe(0)
      expect(emitted).toEqual([{ key: 'empty', text: '' }])
      instance.append('empty', 'visible')
      instance.append('empty', '')
      expect(pending.size).toBe(1)
      expect(instance.flush('empty')).toBe(true)
      expect(emitted.at(-1)).toEqual({ key: 'empty', text: 'visible' })
      instance.append('empty', '')
      expect(instance.flushAll()).toBe(true)
      expect(emitted).toHaveLength(3)
      expect(emitted.at(-1)).toEqual({ key: 'empty', text: 'visible' })
    } finally {
      instance.dispose()
    }
    expect(pending.size).toBe(0)
  })

  it('still refuses a new empty stream while the oldest output is backpressured', () => {
    let accepting = false
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      schedule: () => () => {},
      emit: (key, text) => {
        if (!accepting) {
          return false
        }
        emitted.push([key, text])
        return true
      }
    })
    try {
      instance.append('first', 'preserved')
      expect(instance.append('second', '')).toBe(false)
      expect(instance.snapshot('second')).toBeNull()
      expect(instance.snapshot('first')?.text).toBe('preserved')
      accepting = true
      expect(instance.append('second', '')).toBe(true)
      expect(instance.snapshot('first')).toBeNull()
      expect(instance.snapshot('second')?.text).toBe('')
      expect(instance.flushAll()).toBe(true)
      expect(emitted).toEqual([
        ['first', 'preserved'],
        ['second', '']
      ])
    } finally {
      instance.dispose()
    }
  })
})
