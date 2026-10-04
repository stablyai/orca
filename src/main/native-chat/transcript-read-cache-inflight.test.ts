import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadTranscriptResult } from './transcript-reader'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  stat: vi.fn<() => Promise<{ mtimeMs: number; size: number }>>(),
  read: vi.fn<() => Promise<ReadTranscriptResult>>()
}))

vi.mock('./session-file-resolver', () => ({ resolveSessionFilePath: mocks.resolve }))
vi.mock('./wsl-transcript-fs-access', () => ({ wslGatedStat: mocks.stat }))
vi.mock('./transcript-reader', () => ({ readNativeChatTranscript: mocks.read }))

import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from './transcript-read-cache'
import {
  WSL_TRANSCRIPT_FS_SLOW_MESSAGE,
  wslTranscriptFsTimeoutError
} from './wsl-transcript-fs-error'

beforeEach(() => {
  clearNativeChatTranscriptCache()
  vi.resetAllMocks()
  mocks.resolve.mockResolvedValue('/repo/session.jsonl')
  mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 10 })
})

describe('concurrent transcript cache reads', () => {
  it('parses a shared file generation once across simultaneous clients and session aliases', async () => {
    const pending = Promise.withResolvers<ReadTranscriptResult>()
    const result: ReadTranscriptResult = { messages: [] }
    mocks.read.mockReturnValue(pending.promise)
    const calls = Array.from({ length: 8 }, (_, i) =>
      readNativeChatTranscriptCached('claude', `session-alias-${i}`)
    )

    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(8))
    pending.resolve(result)

    expect((await Promise.all(calls)).every((value) => value === result)).toBe(true)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(result)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(mocks.stat).toHaveBeenCalledTimes(9)
  })

  it('does not share a session id across distinct resolved files or agents', async () => {
    const first = Promise.withResolvers<ReadTranscriptResult>()
    const second = Promise.withResolvers<ReadTranscriptResult>()
    const third = Promise.withResolvers<ReadTranscriptResult>()
    mocks.resolve
      .mockResolvedValueOnce('/repo-a/session.jsonl')
      .mockResolvedValueOnce('/repo-b/session.jsonl')
      .mockResolvedValueOnce('/repo-a/session.jsonl')
    mocks.read
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
    const calls = [
      readNativeChatTranscriptCached('claude', 'session'),
      readNativeChatTranscriptCached('claude', 'session'),
      readNativeChatTranscriptCached('codex', 'session')
    ]
    const results: ReadTranscriptResult[] = [{ messages: [] }, { messages: [] }, { messages: [] }]
    first.resolve(results[0])
    second.resolve(results[1])
    third.resolve(results[2])

    const actual = await Promise.all(calls)
    actual.forEach((value, i) => expect(value).toBe(results[i]))
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })

  it.each([
    { mtimeMs: 2, size: 10 },
    { mtimeMs: 1, size: 20 }
  ])('does not let an older parse overwrite changed file stats %j', async (changedStat) => {
    const oldRead = Promise.withResolvers<ReadTranscriptResult>()
    const oldResult: ReadTranscriptResult = { messages: [] }
    const newResult: ReadTranscriptResult = { messages: [] }
    mocks.read.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(newResult)
    const first = readNativeChatTranscriptCached('claude', 'session')
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))

    mocks.stat.mockResolvedValue(changedStat)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(newResult)
    oldRead.resolve(oldResult)
    await expect(first).resolves.toBe(oldResult)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(newResult)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('invalidates a completed parse when size changes without an mtime change', async () => {
    const first: ReadTranscriptResult = { messages: [] }
    const second: ReadTranscriptResult = { messages: [] }
    mocks.read.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(first)
    mocks.stat.mockResolvedValue({ mtimeMs: 1, size: 20 })

    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(second)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('rechecks the cache when another read completes during stat', async () => {
    const slowStat = Promise.withResolvers<{ mtimeMs: number; size: number }>()
    const result: ReadTranscriptResult = { messages: [] }
    mocks.stat.mockReturnValueOnce(slowStat.promise)
    mocks.read.mockResolvedValue(result)
    const delayed = readNativeChatTranscriptCached('claude', 'session')
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(1))
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(result)
    slowStat.resolve({ mtimeMs: 1, size: 10 })

    await expect(delayed).resolves.toBe(result)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('serves the latest completed parse if a concurrent stat is refused', async () => {
    const first: ReadTranscriptResult = { messages: [] }
    const latest: ReadTranscriptResult = { messages: [] }
    mocks.read.mockResolvedValueOnce(first).mockResolvedValueOnce(latest)
    await readNativeChatTranscriptCached('claude', 'session')

    const slowStat = Promise.withResolvers<{ mtimeMs: number; size: number }>()
    mocks.stat.mockReturnValueOnce(slowStat.promise).mockResolvedValue({ mtimeMs: 2, size: 20 })
    const delayed = readNativeChatTranscriptCached('claude', 'session')
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(2))
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(latest)
    slowStat.reject(wslTranscriptFsTimeoutError())

    await expect(delayed).resolves.toBe(latest)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(latest)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'stat', 'read'] as const)(
    'clear fences work waiting on %s',
    async (stage) => {
      const oldResult: ReadTranscriptResult = { messages: [] }
      const freshResult: ReadTranscriptResult = { messages: [] }
      const pending = Promise.withResolvers<void>()
      if (stage === 'resolve') {
        mocks.resolve.mockImplementationOnce(async () => {
          await pending.promise
          return '/repo/session.jsonl'
        })
      } else if (stage === 'stat') {
        mocks.stat.mockImplementationOnce(async () => {
          await pending.promise
          return { mtimeMs: 1, size: 10 }
        })
      } else {
        mocks.read.mockImplementationOnce(async () => {
          await pending.promise
          return oldResult
        })
      }
      const oldCall = readNativeChatTranscriptCached('claude', 'session')
      await vi.waitFor(() => expect(mocks[stage]).toHaveBeenCalledTimes(1))
      clearNativeChatTranscriptCache()
      mocks.read.mockResolvedValue(freshResult)
      await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(freshResult)
      mocks.read.mockResolvedValue(oldResult)
      pending.resolve()

      await expect(oldCall).resolves.toBe(oldResult)
      await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toBe(freshResult)
      expect(mocks.read).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    { error: WSL_TRANSCRIPT_FS_SLOW_MESSAGE },
    { error: 'File was rotated', notFound: true } as const
  ])('shares a retryable result only while in flight: %j', async (error) => {
    const pending = Promise.withResolvers<ReadTranscriptResult>()
    mocks.read.mockReturnValueOnce(pending.promise).mockResolvedValue({ messages: [] })
    const first = readNativeChatTranscriptCached('claude', 'session')
    const second = readNativeChatTranscriptCached('claude', 'session')
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(2))
    pending.resolve(error)

    expect(await Promise.all([first, second])).toEqual([error, error])
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toEqual({
      messages: []
    })
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('retries a rejected body read', async () => {
    mocks.read.mockRejectedValueOnce(new Error('read failure')).mockResolvedValue({ messages: [] })
    await expect(readNativeChatTranscriptCached('claude', 'session')).rejects.toThrow(
      'read failure'
    )
    await expect(readNativeChatTranscriptCached('claude', 'session')).resolves.toEqual({
      messages: []
    })
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('does not share or cache reads whose file generation could not be determined', async () => {
    mocks.stat.mockRejectedValue(new Error('stat failed'))
    mocks.read.mockImplementation(async () => ({ messages: [] }))
    const [first, second] = await Promise.all([
      readNativeChatTranscriptCached('claude', 'session'),
      readNativeChatTranscriptCached('claude', 'session')
    ])
    expect(first).not.toBe(second)
    await readNativeChatTranscriptCached('claude', 'session')
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })
})
