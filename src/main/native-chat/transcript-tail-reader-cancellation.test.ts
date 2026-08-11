import type * as NodeFsPromisesModule from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

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

describe('native chat transcript tail cancellation', () => {
  it('rejects after pending tail I/O closes when the request is canceled', async () => {
    let finishRead: (() => void) | undefined
    const close = vi.fn(async () => {})
    const read = vi.fn(
      (buffer: Buffer) =>
        new Promise<{ bytesRead: number; buffer: Buffer }>((resolve) => {
          finishRead = () => {
            buffer[0] = 0x0a
            resolve({ bytesRead: 1, buffer })
          }
        })
    )
    fsMocks.stat.mockResolvedValue({ size: 1 })
    fsMocks.open.mockResolvedValue({ close, read })
    const controller = new AbortController()
    const canceled = new Error('request canceled')
    const pending = readNativeChatTranscriptTail(
      {
        agent: 'claude',
        sessionId: 'session-id',
        filePath: 'transcript.jsonl',
        limit: 40
      },
      controller.signal
    )
    const rejection = expect(pending).rejects.toBe(canceled)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())

    controller.abort(canceled)
    finishRead?.()

    await rejection
    expect(close).toHaveBeenCalledOnce()
  })
})
