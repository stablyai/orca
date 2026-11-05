import { describe, expect, it } from 'vitest'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'

// Compare against the old eager append to preserve exact UTF-16 output for every chunk sequence.
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

describe('RecentPtyOutputBuffer', () => {
  it('trims exactly at a chunk boundary when the cap is crossed', () => {
    const half = 'a'.repeat(RECENT_PTY_OUTPUT_LIMIT / 2)
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

  it('matches the old UTF-16 slice behavior for multi-byte content at the boundary', () => {
    // Preserve legacy UTF-16 slicing, including split surrogate pairs.
    const emoji = '\u{1f600}'
    const filler = 'f'.repeat(RECENT_PTY_OUTPUT_LIMIT - 1)
    const chunks = [emoji.repeat(3), filler]
    const tail = bufferTail(chunks)
    expect(tail).toBe(referenceTail(chunks))
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
})
