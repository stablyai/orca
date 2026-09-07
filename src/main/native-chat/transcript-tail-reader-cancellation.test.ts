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

describe('native chat transcript tail cancellation', () => {
  beforeEach(() => {
    fsMocks.open.mockReset()
    fsMocks.stat.mockReset()
  })

  it('closes after a pending tail read without reading another chunk when canceled', async () => {
    let finishTailRead: (() => void) | undefined
    let readCount = 0
    const close = vi.fn(async () => {})
    const read = vi.fn((buffer: Buffer) => {
      readCount++
      if (readCount === 1) {
        buffer[0] = 0x0a
        return Promise.resolve({ bytesRead: 1, buffer })
      }
      if (readCount > 2) {
        buffer.fill(0x0a)
        return Promise.resolve({ bytesRead: buffer.length, buffer })
      }
      return new Promise<{ bytesRead: number; buffer: Buffer }>((resolve) => {
        finishTailRead = () => {
          buffer.fill(0x0a)
          resolve({ bytesRead: buffer.length, buffer })
        }
      })
    })
    fsMocks.stat.mockResolvedValue({ size: 8 * 64 * 1024 + 1 })
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
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))

    controller.abort(canceled)
    finishTailRead?.()

    await rejection
    expect(read).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a handle opened after cancellation without starting a read', async () => {
    let finishOpen: (() => void) | undefined
    const close = vi.fn(async () => {})
    const read = vi.fn()
    fsMocks.stat.mockResolvedValue({ size: 1 })
    fsMocks.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = () => resolve({ close, read })
        })
    )
    const controller = new AbortController()
    const canceled = new Error('request canceled while opening')
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
    await vi.waitFor(() => expect(fsMocks.open).toHaveBeenCalledOnce())

    controller.abort(canceled)
    finishOpen?.()

    await rejection
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})
