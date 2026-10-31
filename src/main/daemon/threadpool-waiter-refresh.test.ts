import { stat } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFifoHoldRound,
  libuvThreadpoolSize,
  startThreadpoolWaiterRefresh,
  THREADPOOL_WAITER_HOLD_MS,
  type RefreshRound
} from './threadpool-waiter-refresh'

afterEach(() => vi.useRealTimers())

describe('threadpool waiter refresh', () => {
  it.runIf(process.platform === 'darwin')(
    'holds every worker at once, so no worker can take two of a round’s reads',
    async () => {
      const round = await createFifoHoldRound()
      if (!round) {
        throw new Error('mkfifo hold was not created')
      }
      const startedAt = Date.now()
      let roundDoneAt = 0
      const roundDone = new Promise<void>((resolve) =>
        round(libuvThreadpoolSize(), () => {
          roundDoneAt = Date.now()
          resolve()
        })
      )
      // Pool work posted during the hold only runs once all of the round's reads are released.
      const statDoneAt = await new Promise<number>((resolve) =>
        stat('/', () => resolve(Date.now()))
      )
      await roundDone
      expect(statDoneAt - startedAt).toBeGreaterThanOrEqual(THREADPOOL_WAITER_HOLD_MS - 2)
      expect(roundDoneAt - startedAt).toBeGreaterThanOrEqual(THREADPOOL_WAITER_HOLD_MS - 2)
    }
  )

  it('runs one round per interval and adds no work while a round is unfinished', async () => {
    vi.useFakeTimers()
    const finish: (() => void)[] = []
    const round = vi.fn<RefreshRound>((_threads, done) => void finish.push(done))
    const stop = startThreadpoolWaiterRefresh({
      platform: 'darwin',
      threads: 3,
      intervalMs: 1_000,
      createRound: async () => round
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(round).toHaveBeenCalledTimes(1)
    expect(round).toHaveBeenCalledWith(3, expect.any(Function))
    finish[0]()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(round).toHaveBeenCalledTimes(2)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing off macOS or when the hold cannot be created', async () => {
    vi.useFakeTimers()
    const createRound = vi.fn(async () => null)
    startThreadpoolWaiterRefresh({ platform: 'linux', intervalMs: 1_000, createRound })
    expect(createRound).not.toHaveBeenCalled()
    startThreadpoolWaiterRefresh({ platform: 'darwin', intervalMs: 1_000, createRound })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sizes the round the way libuv sizes its pool', () => {
    expect(libuvThreadpoolSize({})).toBe(4)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '8' })).toBe(8)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '0' })).toBe(1)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: 'x' })).toBe(1)
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '5000' })).toBe(1024)
  })
})
