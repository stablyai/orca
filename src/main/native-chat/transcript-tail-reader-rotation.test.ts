import type * as NodeFsPromisesModule from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  open: fsMocks.open,
  stat: fsMocks.stat
}))

import { readNativeChatTranscriptTail } from './transcript-tail-reader'

describe('readNativeChatTranscriptTail rotation under the opening stat', () => {
  beforeEach(() => {
    fsMocks.open.mockReset()
    fsMocks.stat.mockReset()
  })

  it('clamps to the live handle size instead of seeking past a replaced file', async () => {
    // Path-level stat still sees the long transcript; by the time we open, the
    // inode is empty (rotated away). Without the live-size clamp the reader
    // would seek at the inflated offset.
    const close = vi.fn(async () => {})
    const handleStat = vi.fn(async () => ({ size: 0 }))
    const read = vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer }))
    fsMocks.stat.mockResolvedValue({ size: 64 * 1024 })
    fsMocks.open.mockResolvedValue({ close, read, stat: handleStat })

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'session-id',
      filePath: 'transcript.jsonl',
      limit: 40
    })

    expect(handleStat).toHaveBeenCalled()
    expect(result).toMatchObject({ completedTo: 0, messages: [] })
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns an empty cursor when the final-byte read short-circuits past EOF', async () => {
    const close = vi.fn(async () => {})
    const handleStat = vi.fn(async () => ({ size: 4 }))
    // liveEnd agrees with the path stat, but the byte at consumedTo-1 is gone
    // by the time we read it (truncated after handle.stat).
    const read = vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer }))
    fsMocks.stat.mockResolvedValue({ size: 4 })
    fsMocks.open.mockResolvedValue({ close, read, stat: handleStat })

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'session-id',
      filePath: 'transcript.jsonl',
      limit: 40
    })

    expect(result).toMatchObject({ completedTo: 0, messages: [] })
    expect(close).toHaveBeenCalledOnce()
  })
})
