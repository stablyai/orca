import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  resetWslTranscriptFsGateForTests,
  runWslTranscriptFsTask,
  WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS,
  WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS
} from './wsl-transcript-fs-gate'
import { WSL_TRANSCRIPT_FS_ROUTE_STRIKE_DECAY_MS } from './wsl-transcript-fs-route-quarantine'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  return {
    promise: new Promise<T>((res, rej) => ((resolve = res), (reject = rej))),
    resolve,
    reject
  }
}

function run(
  path: string,
  priority: 'exact' | 'scan',
  task: () => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  return runWslTranscriptFsTask(
    { operation: priority === 'exact' ? 'access' : 'readdir', path, priority, signal },
    task
  )
}

describe('WSL transcript fs route quarantine strike accounting', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    resetWslTranscriptFsGateForTests()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  // Why: joining costs no new I/O — the in-flight task is bounded by its own
  // deadline and its settle may itself lift the quarantine. Refusing would fail
  // pollers whose answer is already seconds away.
  it('joins a live in-flight task on a quarantined route instead of refusing', async () => {
    vi.useFakeTimers()
    const scanWork = deferred<string>()
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\join-during-quarantine'
      const scanTask = vi.fn(() => scanWork.promise)
      const scanned = runWslTranscriptFsTask(
        { operation: 'stat', path, priority: 'scan' },
        scanTask
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(scanTask).toHaveBeenCalledOnce()

      const stalled = run(
        '\\\\wsl.localhost\\Ubuntu\\join-hung',
        'exact',
        () => new Promise<string>(() => {})
      )
      const stalledRejected = expect(stalled).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await stalledRejected

      // New work on the route is refused, but joining the live stat is free.
      await expect(
        run('\\\\wsl.localhost\\Ubuntu\\join-fresh', 'exact', async () => 'fresh')
      ).rejects.toMatchObject({ code: 'unavailable' })
      const joinerTask = vi.fn(async () => 'never')
      const joined = runWslTranscriptFsTask(
        { operation: 'stat', path, priority: 'scan' },
        joinerTask
      )

      scanWork.resolve('shared')
      await expect(Promise.all([scanned, joined])).resolves.toEqual(['shared', 'shared'])
      expect(joinerTask).not.toHaveBeenCalled()
    } finally {
      scanWork.resolve('shared')
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  // Why: one hung mount usually stalls the exact and scan lanes together; two
  // deadline strikes for one incident would double-step the back-off.
  it('counts concurrent lane deadlines on one stall as a single strike', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      const path = '\\\\wsl.localhost\\Ubuntu\\two-lane-stall'
      const exact = run(path, 'exact', () => new Promise<string>(() => {}))
      const scan = run(
        '\\\\wsl.localhost\\Ubuntu\\two-lane-tree',
        'scan',
        () => new Promise<string>(() => {})
      )
      const exactRejected = expect(exact).rejects.toMatchObject({ code: 'timeout' })
      const scanRejected = expect(scan).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS)
      await Promise.all([exactRejected, scanRejected])

      // Still a first strike: admitted again after one base window (a second
      // strike would demand two).
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(run(path, 'exact', async () => 'recovered')).resolves.toBe('recovered')
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the back-off from the base window again after strike history decays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const path = '\\\\wsl.localhost\\Ubuntu\\daily-slow-wake'
    const stallOnce = (): Promise<string> =>
      runWslTranscriptFsTask(
        { operation: 'open', path, priority: 'exact', dedupe: false },
        (signal) =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          )
      )
    try {
      const first = stallOnce()
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await firstRejected

      // A quiet stretch beyond the decay window forgets the strike history.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_STRIKE_DECAY_MS + 1)
      const second = stallOnce()
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await secondRejected

      // First-strike back-off again, not an escalated second strike.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS)
      await expect(run(path, 'exact', async () => 'fresh-start')).resolves.toBe('fresh-start')
    } finally {
      vi.useRealTimers()
    }
  })
})
