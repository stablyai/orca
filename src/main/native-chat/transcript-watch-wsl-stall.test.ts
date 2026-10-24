import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { NativeChatMessage } from '../../shared/native-chat-types'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\session.jsonl'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<string | null>>(),
  stat: vi.fn(),
  open: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({ resolveSessionFilePath: mocks.resolve }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
}))
vi.mock('./transcript-native-watcher', () => ({
  createTranscriptNativeWatcher: () => ({
    bind: () => true,
    needsRebind: () => false,
    invalidate: () => {},
    dispose: () => {}
  })
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  stat: mocks.stat,
  open: mocks.open
}))

import { subscribeNativeChatTranscript } from './transcript-watch'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS
} from './wsl-transcript-fs-gate'

const SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'

type Snapshot = [NativeChatMessage[], boolean, number, string | undefined]

let releaseStall: (() => void) | undefined
let unhandled: unknown[] = []

function stalls<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve(undefined as T)
  })
}

function subscribeCollecting(snapshots: Snapshot[]) {
  return subscribeNativeChatTranscript({
    agent: 'claude',
    sessionId: 'session-id',
    onAppend: () => {},
    onInitialSnapshot: (messages, hasMore, beforeOffset, error) => {
      snapshots.push([messages, hasMore, beforeOffset, error])
    },
    initialLimit: 10,
    resolvePollIntervalMs: 50,
    reconciliationIntervalMs: 1_000
  })
}

function trackUnhandled(reason: unknown): void {
  unhandled.push(reason)
}

beforeEach(() => {
  // Reset persistent quarantine so stalls cannot leak between cases.
  resetWslTranscriptFsGateForTests()
  mocks.resolve.mockReset()
  mocks.stat.mockReset()
  mocks.open.mockReset()
  releaseStall = undefined
  unhandled = []
  process.on('unhandledRejection', trackUnhandled)
  vi.useFakeTimers()
})

afterEach(async () => {
  releaseStall?.()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  process.off('unhandledRejection', trackUnhandled)
})

const EMPTY_STATS = { size: 0, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1, mtime: new Date(0) }

describe('native chat transcript subscription with a stalled install stat', () => {
  it('keeps watching and emits exactly one retryable snapshot, then the real one', async () => {
    mocks.resolve.mockResolvedValue(UNC_PATH)
    // Real performance.now may expire quarantine mid-test; every retry must still find the mocked mount stalled.
    const pendingStats: ((stats: typeof EMPTY_STATS) => void)[] = []
    mocks.stat.mockImplementation(
      () => new Promise((resolve) => pendingStats.push(resolve as never))
    )
    const snapshots: Snapshot[] = []

    const subscribing = subscribeCollecting(snapshots)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    const subscription = await subscribing
    expect(subscription.watching).toBe(true)

    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    expect(snapshots).toEqual([[[], false, 0, SLOW_MESSAGE]])

    await vi.advanceTimersByTimeAsync(500)
    expect(snapshots).toHaveLength(1)

    mocks.stat.mockResolvedValue(EMPTY_STATS)
    for (const release of pendingStats.splice(0)) {
      release(EMPTY_STATS)
    }
    await vi.advanceTimersByTimeAsync(500)

    expect(snapshots.length).toBeGreaterThan(1)
    expect(snapshots.at(-1)?.[3]).toBeUndefined()
    subscription.unsubscribe()
    expect(unhandled).toEqual([])
  })

  it('keeps the poll loop alive on a non-gate resolve failure without emitting a frame', async () => {
    mocks.resolve
      .mockResolvedValueOnce(null)
      .mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    const snapshots: Snapshot[] = []

    const subscription = await subscribeCollecting(snapshots)
    const attemptsAfterSetup = mocks.resolve.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)

    expect(snapshots).toEqual([])
    expect(mocks.resolve.mock.calls.length).toBeGreaterThan(attemptsAfterSetup)
    expect(unhandled).toEqual([])
    subscription.unsubscribe()
  })

  it('detaches drain waiters on unsubscribe and starts no further gated work', async () => {
    mocks.resolve.mockResolvedValue(UNC_PATH)
    mocks.stat.mockResolvedValue({ ...EMPTY_STATS, size: 64 })
    let releaseOpen: ((handle: unknown) => void) | undefined
    mocks.open.mockReturnValue(
      new Promise((resolve) => {
        releaseOpen = resolve
      })
    )
    const handle = {
      read: vi.fn(async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) })),
      close: vi.fn(async () => {})
    }

    const subscription = await subscribeCollecting([])
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    const statCallsAtTeardown = mocks.stat.mock.calls.length

    subscription.unsubscribe()
    // Detach immediately on unsubscribe without waiting for the gate deadline.
    releaseOpen?.(handle)
    await vi.advanceTimersByTimeAsync(0)

    expect(handle.read).not.toHaveBeenCalled()
    expect(mocks.stat.mock.calls.length).toBe(statCallsAtTeardown)
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })

  it('tears down cleanly while an admission is still stalled', async () => {
    mocks.resolve.mockResolvedValue(UNC_PATH)
    mocks.stat.mockImplementation(stalls)
    const snapshots: Snapshot[] = []

    const subscribing = subscribeCollecting(snapshots)
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    const subscription = await subscribing

    expect(() => subscription.unsubscribe()).not.toThrow()
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
    expect(unhandled).toEqual([])
  })
})
