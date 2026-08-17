import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\session.jsonl'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  open: mocks.open
}))

import { readNativeChatTranscript } from './transcript-reader'
import { WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS } from './wsl-transcript-fs-gate'

const SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'

const LINE = JSON.stringify({
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: 'hi' }
})

function handleServing(body: Buffer, delayMs = 0) {
  return {
    read: vi.fn(
      (buffer: Buffer, offset: number, length: number, position: number) =>
        new Promise((resolve) => {
          const slice = body.subarray(position, Math.min(position + length, body.length))
          slice.copy(buffer, offset)
          const settle = () => resolve({ bytesRead: slice.length, buffer })
          if (delayMs > 0) {
            setTimeout(settle, delayMs)
          } else {
            settle()
          }
        })
    ),
    close: vi.fn(async () => {})
  }
}

beforeEach(() => {
  mocks.open.mockReset()
})

describe('native chat transcript read with a stalled post-resolution body read', () => {
  it('surfaces a retryable error without notFound when the first chunk never settles', async () => {
    vi.useFakeTimers()
    try {
      mocks.open.mockResolvedValue({
        read: vi.fn(() => new Promise(() => {})),
        close: vi.fn(async () => {})
      })
      const reading = readNativeChatTranscript('claude', 'session-id', { filePath: UNC_PATH })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)

      const result = await reading
      expect(result).toEqual({ error: SLOW_MESSAGE })
      expect(result).not.toHaveProperty('notFound')
    } finally {
      vi.useRealTimers()
    }
  })

  it('succeeds when every chunk is slow but under the deadline, past the whole-file budget', async () => {
    vi.useFakeTimers()
    const healthyPath = '\\\\wsl.localhost\\Debian\\home\\ada\\.claude\\projects\\p\\session.jsonl'
    try {
      const chunkDelayMs = WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS / 2
      mocks.open.mockResolvedValue(handleServing(Buffer.from(`${LINE}\n`), chunkDelayMs))
      const reading = readNativeChatTranscript('claude', 'session-id', { filePath: healthyPath })

      // Two chunk admissions (body + EOF probe) span more than one exact deadline.
      await vi.advanceTimersByTimeAsync(chunkDelayMs * 4)

      const result = await reading
      expect(result).toMatchObject({ messages: [expect.objectContaining({ id: 'u1' })] })
    } finally {
      vi.useRealTimers()
    }
  })
})
