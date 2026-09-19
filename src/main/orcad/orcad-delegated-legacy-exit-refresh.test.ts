import { afterEach, expect, it, vi } from 'vitest'
import { createOrcadDelegatedExecutionRefresh } from './orcad-delegated-execution-refresh'

afterEach(() => vi.useRealTimers())
function setup() {
  vi.useFakeTimers()
  const options = {
    isActive: vi.fn(() => true),
    isReady: vi.fn(() => true),
    refresh: vi.fn(async () => {}),
    onError: vi.fn(),
    probeFinalOutputSeq: vi.fn(async (): Promise<number | null> => null)
  }
  return { ...options, loop: createOrcadDelegatedExecutionRefresh(options) }
}

it('checks old sources at a bounded interval and stops once exit is confirmed', async () => {
  const f = setup()
  await vi.advanceTimersByTimeAsync(1999)
  expect(f.probeFinalOutputSeq).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.probeFinalOutputSeq).toHaveBeenCalledOnce()
  expect(f.refresh).not.toHaveBeenCalled()
  f.probeFinalOutputSeq.mockResolvedValue(4)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.refresh).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.probeFinalOutputSeq).toHaveBeenCalledTimes(2)
  await f.loop.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not equate a failed status read with exit', async () => {
  const f = setup()
  f.probeFinalOutputSeq.mockRejectedValueOnce(new Error('timeout'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.onError).toHaveBeenCalledOnce()
  expect(f.refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.probeFinalOutputSeq).toHaveBeenCalledTimes(2)
  await f.loop.dispose()
})

it('never overlaps source checks and waits for in-flight disposal', async () => {
  const f = setup()
  let finish!: (seq: number | null) => void
  f.probeFinalOutputSeq.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.probeFinalOutputSeq).toHaveBeenCalledOnce()
  let stopped = false
  const stop = f.loop.dispose().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  finish(4)
  await stop
  expect(f.refresh).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('still waits for model drain after learning the final cursor from an old source', async () => {
  const f = setup()
  f.isReady.mockReturnValue(false)
  f.probeFinalOutputSeq.mockResolvedValue(4)
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.probeFinalOutputSeq).toHaveBeenCalledOnce()
  expect(f.refresh).not.toHaveBeenCalled()
  f.isReady.mockReturnValue(true)
  f.loop.wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.refresh).toHaveBeenCalledOnce()
  await f.loop.dispose()
})
