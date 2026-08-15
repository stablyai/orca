import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

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

import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS, WslTranscriptFsError } from './wsl-transcript-fs-gate'

const SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'

describe('native chat transcript tail under WSL gate refusals', () => {
  beforeEach(() => {
    mocks.resolve.mockReset()
  })

  it('reports a gate refusal as a retryable error, not a missing transcript', async () => {
    mocks.resolve.mockRejectedValueOnce(new WslTranscriptFsError('timeout', 'slow share'))

    await expect(
      readNativeChatTranscriptTail({ agent: 'codex', sessionId: 'session-id', limit: 10 })
    ).resolves.toEqual({ error: 'slow share' })
  })

  it('rethrows non-gate resolver failures', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('resolver crashed'))

    await expect(
      readNativeChatTranscriptTail({ agent: 'codex', sessionId: 'session-id', limit: 10 })
    ).rejects.toThrow('resolver crashed')
  })
})

describe('native chat transcript tail with stalled post-resolution UNC I/O', () => {
  const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\a.jsonl'
  // A stalled task holds its gate permit until the underlying call settles, so
  // each case releases its stall before the next one runs.
  let releaseStall: (() => void) | undefined

  function stalls<T>(): Promise<T> {
    return new Promise<T>((resolve) => {
      releaseStall = () => resolve(undefined as T)
    })
  }

  async function tailAfterStall(): Promise<unknown> {
    const pending = readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'session-id',
      filePath: UNC_PATH,
      limit: 10
    })
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    return pending
  }

  beforeEach(() => {
    mocks.stat.mockReset()
    mocks.open.mockReset()
    releaseStall = undefined
    vi.useFakeTimers()
  })

  afterEach(async () => {
    releaseStall?.()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  it('reports a stalled stat as retryable without notFound', async () => {
    mocks.stat.mockImplementation(stalls)
    const result = await tailAfterStall()
    expect(result).toEqual({ error: SLOW_MESSAGE })
    expect(result).not.toHaveProperty('notFound')
  })

  it('reports a stalled open as retryable without notFound', async () => {
    mocks.stat.mockResolvedValue({ size: 4096 })
    mocks.open.mockImplementation(stalls)
    const result = await tailAfterStall()
    expect(result).toEqual({ error: SLOW_MESSAGE })
    expect(result).not.toHaveProperty('notFound')
  })

  it('closes the handle without a second admission when a positional read stalls', async () => {
    const close = vi.fn(async () => {})
    mocks.stat.mockResolvedValue({ size: 4096 })
    mocks.open.mockResolvedValue({ read: vi.fn(stalls), close })

    const result = await tailAfterStall()

    expect(result).toEqual({ error: SLOW_MESSAGE })
    expect(result).not.toHaveProperty('notFound')
    // Fire-and-forget close: never gated, never awaited, exactly once.
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
