import { afterEach, describe, expect, it, vi } from 'vitest'
import { RETAINED_STRING_CHUNK_LIMIT } from '../../shared/string-chunk-compaction'
import {
  TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES,
  TERMINAL_PREVIEW_PENDING_MAX_RECORDS,
  TerminalPreviewOutputStream
} from './terminal-preview-output-stream'

function makeStream() {
  const contents = {
    isDestroyed: () => false,
    send: vi.fn()
  }
  const stream = new TerminalPreviewOutputStream(contents as never, 'pty-1', vi.fn(), vi.fn())
  return { contents, stream }
}

describe('TerminalPreviewOutputStream memory bounds', () => {
  afterEach(() => vi.useRealTimers())

  it('ignores empty snapshot records and resyncs when tiny records reach the count cap', () => {
    const { stream } = makeStream()

    for (let index = 0; index < 100_000; index += 1) {
      stream.append('', { seq: index, rawLength: 0 })
    }
    expect(stream.consumeInitialOverflow()).toBe(false)

    for (let index = 0; index <= TERMINAL_PREVIEW_PENDING_MAX_RECORDS; index += 1) {
      stream.append('x', { seq: index + 1, rawLength: 1 })
    }
    expect(stream.consumeInitialOverflow()).toBe(true)
  })

  it('compacts 50,000 live fragments without changing the emitted output', () => {
    vi.useFakeTimers()
    const { contents, stream } = makeStream()
    stream.completeSnapshot()

    for (let index = 0; index < 50_000; index += 1) {
      stream.append(String.fromCharCode(97 + (index % 26)))
    }
    const retained = stream as unknown as { batchChunks: string[] }
    expect(retained.batchChunks.length).toBeLessThanOrEqual(RETAINED_STRING_CHUNK_LIMIT)

    vi.advanceTimersByTime(5)
    expect(contents.send).toHaveBeenCalledWith(
      'terminalPreview:data',
      expect.objectContaining({ data: expect.stringMatching(/^[a-z]{50000}$/), bytes: 50_000 })
    )
  })

  it('resyncs when a stalled renderer accumulates too many tiny pending batches', () => {
    vi.useFakeTimers()
    const { contents, stream } = makeStream()
    stream.completeSnapshot()
    const fullBatch = 'x'.repeat(TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES)

    for (let index = 0; index < 8; index += 1) {
      stream.append(fullBatch)
    }
    for (let index = 0; index <= TERMINAL_PREVIEW_PENDING_MAX_RECORDS; index += 1) {
      stream.append('x')
      vi.advanceTimersByTime(5)
    }

    stream.acknowledge(8 * TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES)
    expect(contents.send).toHaveBeenLastCalledWith('terminalPreview:data', {
      type: 'resync',
      ptyId: 'pty-1'
    })
  })
})
