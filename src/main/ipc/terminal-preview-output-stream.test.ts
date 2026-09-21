import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { TerminalPreviewOutputStream } from './terminal-preview-output-stream'

function makeStream(): TerminalPreviewOutputStream {
  const contents = {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn()
  } as unknown as WebContents
  return new TerminalPreviewOutputStream(
    contents,
    'p1',
    () => undefined,
    () => undefined
  )
}

// The renderer needs each buffered chunk's mode, not just its bytes.
// Returning a bare string[] made a proven post-snapshot `CSI > u` look like
// historical redelivery, so the TUI's single pop later landed on a stale frame.
describe('TerminalPreviewOutputStream.completeSnapshot', () => {
  it('drops chunks the snapshot already covers', () => {
    const stream = makeStream()
    stream.append('abc', { seq: 5, rawLength: 3 })
    expect(stream.completeSnapshot(5)).toEqual([])
  })

  it('gives a strictly newer sequenced chunk live mode', () => {
    const stream = makeStream()
    stream.append('abc', { seq: 9, rawLength: 3 })
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'abc', mode: 'live' }])
  })

  it('slices a partially covered chunk and keeps the suffix live', () => {
    const stream = makeStream()
    stream.append('abc', { seq: 7, rawLength: 3 })
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'c', mode: 'live' }])
  })

  it('falls back to replay mode for an unsliceable transformed overlap', () => {
    const stream = makeStream()
    // Renderer-side transforms make raw offsets unmappable, so the covered head
    // cannot be removed and the whole chunk stays uncertain redelivery.
    stream.append('abc', { seq: 7, rawLength: 3, transformed: true })
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'abc', mode: 'replay' }])
  })

  it('falls back to replay mode when the chunk carries no sequence metadata', () => {
    const stream = makeStream()
    stream.append('abc')
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'abc', mode: 'replay' }])
  })

  it('falls back to replay mode when the snapshot itself is unsequenced', () => {
    const stream = makeStream()
    stream.append('abc', { seq: 9, rawLength: 3 })
    expect(stream.completeSnapshot(undefined)).toEqual([{ data: 'abc', mode: 'replay' }])
  })
})
