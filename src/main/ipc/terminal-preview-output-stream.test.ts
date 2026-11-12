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

// Preserve chunk mode: replaying post-snapshot kitty pushes as redelivery corrupts the later pop.
describe('TerminalPreviewOutputStream.completeSnapshot', () => {
  it('slices a partially covered chunk and keeps the suffix live', () => {
    const stream = makeStream()
    stream.append('abc', { seq: 7, rawLength: 3 })
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'c', mode: 'live' }])
  })

  it('falls back to replay mode for an unsliceable transformed overlap', () => {
    const stream = makeStream()
    // Transformed bytes cannot be split by raw offsets; preserve uncertain redelivery.
    stream.append('abc', { seq: 7, rawLength: 3, transformed: true })
    expect(stream.completeSnapshot(6)).toEqual([{ data: 'abc', mode: 'replay' }])
  })
})
