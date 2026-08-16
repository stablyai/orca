import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\session.jsonl'
const mocks = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<string | null>>(),
  stat: vi.fn(),
  open: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  stat: mocks.stat,
  open: mocks.open
}))

import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from './transcript-read-cache'
import {
  WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS,
  WSL_TRANSCRIPT_FS_SLOW_MESSAGE
} from './wsl-transcript-fs-gate'

const BODY = Buffer.from(
  `${JSON.stringify({
    type: 'user',
    uuid: 'u-0',
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role: 'user', content: 'hello' }
  })}\n`
)

let releaseStall: (() => void) | undefined

function stalls<T>(value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve(value)
  })
}

function transcriptHandle(body = BODY) {
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const slice = body.subarray(position, Math.min(position + length, body.length))
      slice.copy(buffer, offset)
      return { bytesRead: slice.length, buffer }
    }),
    close: vi.fn(async () => {})
  }
}

beforeEach(() => {
  clearNativeChatTranscriptCache()
  mocks.resolve.mockReset()
  mocks.stat.mockReset()
  mocks.open.mockReset()
  releaseStall = undefined
  mocks.resolve.mockResolvedValue(UNC_PATH)
  // The file itself never changes across the refusal and the recovery.
  mocks.stat.mockResolvedValue({ mtimeMs: 42, size: BODY.length })
  vi.useFakeTimers()
})

afterEach(async () => {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

describe('cached native chat transcript read after WSL gate refusals', () => {
  it('retries a refused stat instead of caching it as a missing file', async () => {
    mocks.stat.mockReturnValueOnce(stalls({ mtimeMs: 42, size: BODY.length }))
    const refused = readNativeChatTranscriptCached('claude', 'session-id')
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)

    expect(await refused).toEqual({ error: WSL_TRANSCRIPT_FS_SLOW_MESSAGE })
    releaseStall?.()
    releaseStall = undefined
    await vi.advanceTimersByTimeAsync(0)
    mocks.open.mockResolvedValue(transcriptHandle())

    await expect(readNativeChatTranscriptCached('claude', 'session-id')).resolves.toMatchObject({
      messages: [expect.objectContaining({ role: 'user' })]
    })
    expect(mocks.stat).toHaveBeenCalledTimes(2)
  })

  it('retries the body on the next call even though the mtime is unchanged', async () => {
    mocks.open.mockResolvedValue({
      read: vi.fn((buffer: Buffer) => stalls({ bytesRead: 0, buffer })),
      close: vi.fn(async () => {})
    })
    const refused = readNativeChatTranscriptCached('claude', 'session-id')
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    expect(await refused).toEqual({ error: WSL_TRANSCRIPT_FS_SLOW_MESSAGE })

    releaseStall?.()
    releaseStall = undefined
    await vi.advanceTimersByTimeAsync(0)
    mocks.open.mockResolvedValue(transcriptHandle())

    const recovered = await readNativeChatTranscriptCached('claude', 'session-id')

    expect(mocks.open).toHaveBeenCalledTimes(2)
    expect(recovered).toMatchObject({
      messages: [expect.objectContaining({ role: 'user' })]
    })
  })
})
