import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_STREAMED_TEXT_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER as marker,
  createAgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer'

describe('streamed output overflow prefix', () => {
  it('encodes only the retained prefix when 64 KiB command deltas cross the default limit', () => {
    const delta = 'x'.repeat(64 * 1024)
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      emit: (_key, text) => emitted.push(text),
      schedule: () => () => {}
    })
    for (let index = 0; index < 256; index += 1) {
      instance.append('command', delta)
    }
    const from = vi.spyOn(Buffer, 'from')
    const concat = vi.spyOn(Buffer, 'concat')
    const allocate = vi.spyOn(Buffer, 'allocUnsafe')
    try {
      instance.append('command', delta)
      expect(concat).not.toHaveBeenCalled()
      expect(from).toHaveBeenCalledExactlyOnceWith(marker, 'utf8')
      expect(allocate).toHaveBeenCalledExactlyOnceWith(
        AGENT_SESSION_STREAMED_TEXT_MAX_BYTES - Buffer.byteLength(marker)
      )
    } finally {
      from.mockRestore()
      concat.mockRestore()
      allocate.mockRestore()
    }
    const text = 'x'.repeat(AGENT_SESSION_STREAMED_TEXT_MAX_BYTES - marker.length) + marker
    expect(instance.snapshot('command')).toEqual({
      text,
      observedBytes: 257 * delta.length,
      truncated: true
    })
    expect(instance.flushAll()).toBe(true)
    expect(emitted).toEqual([text])
    instance.dispose()
  })

  it('leaves ordinary appends unencoded and joins split surrogates before overflow', () => {
    const instance = createAgentSessionDeltaCoalescer({
      emit: () => true,
      schedule: () => () => {}
    })
    const from = vi.spyOn(Buffer, 'from')
    const concat = vi.spyOn(Buffer, 'concat')
    const allocate = vi.spyOn(Buffer, 'allocUnsafe')
    try {
      instance.append('command', '\ud800')
      instance.append('command', '')
      instance.append('command', '\udc00')
      expect(from).not.toHaveBeenCalled()
      expect(concat).not.toHaveBeenCalled()
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      from.mockRestore()
      concat.mockRestore()
      allocate.mockRestore()
    }
    expect(instance.snapshot('command')).toEqual({
      text: '\ud800\udc00',
      observedBytes: 6,
      truncated: false
    })
    instance.dispose()
  })

  it.each([
    { cap: 0, chunks: ['abcdef'], text: '' },
    { cap: 1, chunks: ['abcdef'], text: '\n' },
    { cap: 33, chunks: ['x'.repeat(40)], text: marker.slice(0, 33) },
    { cap: 34, chunks: ['x'.repeat(40)], text: marker },
    { cap: 35, chunks: ['é', 'x'.repeat(40)], text: marker },
    { cap: 36, chunks: ['a€', 'x'.repeat(40)], text: `a${marker}` },
    { cap: 37, chunks: ['a€', 'x'.repeat(40)], text: `a${marker}` },
    { cap: 38, chunks: ['a€', 'x'.repeat(40)], text: `a€${marker}` },
    { cap: 40, chunks: ['\ud800', '', '\udc00', 'x'.repeat(40)], text: `\ufffd\ufffd${marker}` },
    { cap: 39, chunks: ['a😀', 'x'.repeat(40)], text: `a😀${marker}` },
    { cap: 38, chunks: ['a😀', 'x'.repeat(40)], text: `a${marker}` }
  ])('preserves chunk encoding and UTF-8 clipping at a $cap byte cap', ({ cap, chunks, text }) => {
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: cap,
      emit: () => true,
      schedule: () => () => {}
    })
    for (const chunk of chunks) {
      instance.append('command', chunk)
    }
    expect(instance.snapshot('command')).toEqual({
      text,
      observedBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0),
      truncated: true
    })
    instance.dispose()
  })

  it.each([
    { cap: Number.NaN, text: '' },
    { cap: Number.NEGATIVE_INFINITY, text: '' },
    { cap: -1, text: marker.slice(0, -1) },
    { cap: 0.1, text: '' },
    { cap: 35.5, text: `a${marker}` },
    { cap: 40.5, text: `abcdef${marker}` }
  ])('preserves the legacy injected budget outcome for $cap', ({ cap, text }) => {
    const delta = 'abcdefghijklmnopqrstuvwxyz'.repeat(2)
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: cap,
      emit: () => true,
      schedule: () => () => {}
    })
    instance.append('command', delta)
    expect(instance.snapshot('command')).toEqual({
      text,
      observedBytes: delta.length,
      truncated: true
    })
    instance.dispose()
  })
})
