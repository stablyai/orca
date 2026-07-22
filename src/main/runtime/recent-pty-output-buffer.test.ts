import { describe, expect, it, vi } from 'vitest'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'

// Reference implementation: the old eager rolling-string append the buffer
// replaced. read() must stay byte-identical to this for any chunk sequence.
function referenceAppend(previous: string | undefined, data: string): string {
  if (data.length >= RECENT_PTY_OUTPUT_LIMIT) {
    return data.slice(-RECENT_PTY_OUTPUT_LIMIT)
  }
  return `${previous ?? ''}${data}`.slice(-RECENT_PTY_OUTPUT_LIMIT)
}

function referenceTail(chunks: string[]): string {
  let tail: string | undefined
  for (const chunk of chunks) {
    tail = referenceAppend(tail, chunk)
  }
  return tail ?? ''
}

function bufferTail(chunks: string[]): string {
  const buffer = new RecentPtyOutputBuffer()
  for (const chunk of chunks) {
    buffer.append(chunk)
  }
  return buffer.read()
}

function expectEquivalent(chunks: string[]): void {
  expect(bufferTail(chunks)).toBe(referenceTail(chunks))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('RecentPtyOutputBuffer', () => {
  it('returns an empty string before any append', () => {
    expect(new RecentPtyOutputBuffer().read()).toBe('')
    expectEquivalent([])
  })

  it('accumulates chunks below the cap verbatim', () => {
    const chunks = ['hello ', 'world', '\r\n', 'prompt $ ']
    expect(bufferTail(chunks)).toBe('hello world\r\nprompt $ ')
    expectEquivalent(chunks)
  })

  it('ignores empty chunks', () => {
    expectEquivalent(['', 'abc', '', 'def', ''])
  })

  it('trims exactly at a chunk boundary when the cap is crossed', () => {
    const half = 'a'.repeat(RECENT_PTY_OUTPUT_LIMIT / 2)
    // Third half-cap chunk should evict the first chunk entirely.
    const chunks = [half, 'b'.repeat(RECENT_PTY_OUTPUT_LIMIT / 2), 'c'.repeat(half.length)]
    const tail = bufferTail(chunks)
    expect(tail.length).toBe(RECENT_PTY_OUTPUT_LIMIT)
    expect(tail.startsWith('b')).toBe(true)
    expectEquivalent(chunks)
  })

  it('truncates the boundary chunk when the cap is crossed mid-chunk', () => {
    const chunks = ['x'.repeat(RECENT_PTY_OUTPUT_LIMIT - 10), `head-tail-${'y'.repeat(20)}`]
    const tail = bufferTail(chunks)
    expect(tail.length).toBe(RECENT_PTY_OUTPUT_LIMIT)
    expect(tail.endsWith('y'.repeat(20))).toBe(true)
    expectEquivalent(chunks)
  })

  it('keeps only the last cap-sized slice of a single oversized chunk', () => {
    const oversized = `${'z'.repeat(RECENT_PTY_OUTPUT_LIMIT)}${'w'.repeat(100)}`
    expect(bufferTail([oversized])).toBe(oversized.slice(-RECENT_PTY_OUTPUT_LIMIT))
    expectEquivalent([oversized])
    // An oversized chunk must also discard everything buffered before it.
    expectEquivalent(['earlier output', oversized, 'later'])
    // Exactly cap-sized hits the old fast path too.
    expectEquivalent(['before', 'q'.repeat(RECENT_PTY_OUTPUT_LIMIT)])
  })

  it('stays byte-identical across many small chunks that trim repeatedly', () => {
    const rng = mulberry32(0x5eed)
    const chunks = Array.from({ length: 5000 }, (_, i) => {
      const len = 1 + Math.floor(rng() * 120)
      return `${i}:${String.fromCharCode(97 + (i % 26)).repeat(len)}\n`
    })
    expectEquivalent(chunks)
  })

  it('matches the old UTF-16 slice behavior for multi-byte content at the boundary', () => {
    // JS string .slice counts UTF-16 code units, so trimming can split a
    // surrogate pair; the buffer must reproduce that split exactly.
    const emoji = '\u{1f600}' // 2 code units
    const filler = 'f'.repeat(RECENT_PTY_OUTPUT_LIMIT - 1)
    const chunks = [emoji.repeat(3), filler]
    const tail = bufferTail(chunks)
    expect(tail).toBe(referenceTail(chunks))
    // The old code left a lone trailing low surrogate at the front.
    expect(tail.charCodeAt(0)).toBe(0xde00)
    expectEquivalent(['多字节内容', emoji.repeat(2000), filler, emoji])
  })

  it('read() is idempotent and append continues correctly after a read', () => {
    const buffer = new RecentPtyOutputBuffer()
    buffer.append('one')
    buffer.append('two')
    expect(buffer.read()).toBe('onetwo')
    expect(buffer.read()).toBe('onetwo')
    buffer.append('three')
    expect(buffer.read()).toBe('onetwothree')
    buffer.append('x'.repeat(RECENT_PTY_OUTPUT_LIMIT))
    expect(buffer.read()).toBe('x'.repeat(RECENT_PTY_OUTPUT_LIMIT))
  })

  it('trims after an interspersed read without slicing the head per append', () => {
    const buffer = new RecentPtyOutputBuffer()
    const fill = 'f'.repeat(RECENT_PTY_OUTPUT_LIMIT)
    buffer.append(fill)
    // Collapse to a single cap-sized head chunk, the reviewer's scenario.
    expect(buffer.read()).toBe(fill)

    const appendCount = 1000
    const smallChunks = Array.from({ length: appendCount }, (_, i) =>
      String.fromCharCode(33 + (i % 90))
    )
    let reference = fill
    for (const chunk of smallChunks) {
      reference = referenceAppend(reference, chunk)
    }

    // Every append now trims one code unit off the full head; none of them
    // may allocate a head substring — the trim must be a deferred offset.
    const sliceSpy = vi.spyOn(String.prototype, 'slice')
    try {
      for (const chunk of smallChunks) {
        buffer.append(chunk)
      }
      expect(sliceSpy).not.toHaveBeenCalled()
    } finally {
      sliceSpy.mockRestore()
    }

    expect(buffer.read()).toBe(reference)
    expect(buffer.read().length).toBe(RECENT_PTY_OUTPUT_LIMIT)
  })

  it('stays byte-identical when reads intersperse repeated partial head trims', () => {
    const buffer = new RecentPtyOutputBuffer()
    let reference: string | undefined
    const rng = mulberry32(0xdeadbeef)
    for (let i = 0; i < 400; i++) {
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(1 + Math.floor(rng() * 300))
      buffer.append(chunk)
      reference = referenceAppend(reference, chunk)
      if (i % 7 === 0) {
        expect(buffer.read()).toBe(reference ?? '')
      }
    }
    expect(buffer.read()).toBe(reference ?? '')
  })

  it('retainedChunks preserves original chunk boundaries within the window', () => {
    const buffer = new RecentPtyOutputBuffer()
    buffer.append('wrote /tmp/a.json')
    buffer.append('suffix.txt')
    expect(buffer.retainedChunks().chunks).toEqual(['wrote /tmp/a.json', 'suffix.txt'])
    expect(buffer.read()).toBe('wrote /tmp/a.jsonsuffix.txt')
    // read() must not collapse the chunk array before compact(): boundaries
    // survive a read so the backfill can still replay original chunks.
    expect(buffer.retainedChunks().chunks).toEqual(['wrote /tmp/a.json', 'suffix.txt'])
  })

  it('retainedChunks keeps the full original head chunk when the window trims mid-chunk', () => {
    const buffer = new RecentPtyOutputBuffer()
    const head = 'a'.repeat(RECENT_PTY_OUTPUT_LIMIT - 5)
    buffer.append(head)
    buffer.append('bbbbbbbbbb')
    buffer.append('cc')
    const { chunks, headChunkIsPartial } = buffer.retainedChunks()
    // The head chunk is intact (its original text, trimmed prefix included)
    // so candidate backfill sees the same input the eager extractor saw.
    expect(chunks).toEqual([head, 'bbbbbbbbbb', 'cc'])
    expect(headChunkIsPartial).toBe(false)
    expect(buffer.read()).toBe(`${'a'.repeat(RECENT_PTY_OUTPUT_LIMIT - 12)}bbbbbbbbbbcc`)
  })

  it('retainedChunks flags a pre-sliced oversized head chunk as partial', () => {
    const buffer = new RecentPtyOutputBuffer()
    buffer.append('z'.repeat(RECENT_PTY_OUTPUT_LIMIT + 100))
    expect(buffer.retainedChunks().headChunkIsPartial).toBe(true)
    buffer.append('tail')
    expect(buffer.retainedChunks().headChunkIsPartial).toBe(true)
    // Once the partial head chunk is fully evicted the flag clears.
    buffer.append('w'.repeat(RECENT_PTY_OUTPUT_LIMIT - 1))
    const { chunks, headChunkIsPartial } = buffer.retainedChunks()
    expect(headChunkIsPartial).toBe(false)
    expect(chunks).toEqual(['tail', 'w'.repeat(RECENT_PTY_OUTPUT_LIMIT - 1)])
    // An exactly cap-sized append is stored whole, not partial.
    const exact = new RecentPtyOutputBuffer()
    exact.append('q'.repeat(RECENT_PTY_OUTPUT_LIMIT))
    expect(exact.retainedChunks().headChunkIsPartial).toBe(false)
  })

  it('compact collapses to a single chunk and restores read-time defragmentation', () => {
    const buffer = new RecentPtyOutputBuffer()
    let reference: string | undefined
    for (let i = 0; i < 200; i++) {
      const chunk = `${i}:${'p'.repeat(700)}\n`
      buffer.append(chunk)
      reference = referenceAppend(reference, chunk)
    }
    buffer.compact()
    expect(buffer.retainedChunks().chunks).toEqual([reference])
    expect(buffer.read()).toBe(reference)
    // After compact, a read re-collapses fragmentation from later appends.
    buffer.append('after')
    reference = referenceAppend(reference, 'after')
    expect(buffer.read()).toBe(reference)
    expect(buffer.retainedChunks().chunks).toEqual([reference])
  })

  it('retainedChunks window-trimmed join always equals read()', () => {
    const rng = mulberry32(0xfeed)
    const buffer = new RecentPtyOutputBuffer()
    const joinRetained = (): string => {
      const { chunks } = buffer.retainedChunks()
      const joined = chunks.join('')
      return joined.slice(Math.max(0, joined.length - RECENT_PTY_OUTPUT_LIMIT))
    }
    for (let i = 0; i < 300; i++) {
      buffer.append(String.fromCharCode(33 + (i % 90)).repeat(Math.floor(rng() * 1500)))
      if (i % 11 === 0) {
        expect(joinRetained()).toBe(buffer.read())
      }
    }
    expect(joinRetained()).toBe(buffer.read())
  })

  it('stays equivalent under randomized chunk sizes straddling the cap', () => {
    const rng = mulberry32(0xc0ffee)
    for (let round = 0; round < 5; round++) {
      const chunks: string[] = []
      const count = 20 + Math.floor(rng() * 60)
      for (let i = 0; i < count; i++) {
        const roll = rng()
        const len =
          roll < 0.1
            ? RECENT_PTY_OUTPUT_LIMIT + Math.floor(rng() * 200) - 100
            : Math.floor(rng() * 9000)
        chunks.push(String.fromCharCode(33 + (i % 90)).repeat(Math.max(0, len)))
      }
      expectEquivalent(chunks)
    }
  })
})
