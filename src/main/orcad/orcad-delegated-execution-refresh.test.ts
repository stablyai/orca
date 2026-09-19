import { afterEach, expect, it, vi } from 'vitest'
import { createOrcadDelegatedExecutionRefresh } from './orcad-delegated-execution-refresh'

function setup() {
  const options = {
    isActive: vi.fn(() => true),
    isReady: vi.fn(() => true),
    refresh: vi.fn(async () => {}),
    onError: vi.fn()
  }
  return { ...options, refreshLoop: createOrcadDelegatedExecutionRefresh(options) }
}
afterEach(() => vi.useRealTimers())

it('retries a failed status refresh and cancels retries on disposal', async () => {
  vi.useFakeTimers()
  const f = setup()
  f.refresh.mockRejectedValueOnce(new Error('status unavailable'))
  f.refreshLoop.request(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.onError).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  await f.refreshLoop.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for final output and commit readiness without polling', async () => {
  const f = setup()
  f.isReady.mockReturnValue(false)
  f.refreshLoop.request(3)
  await Promise.resolve()
  expect(f.refresh).not.toHaveBeenCalled()
  f.isReady.mockReturnValue(true)
  f.refreshLoop.wake()
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce())
  f.refreshLoop.request(3)
  await f.refreshLoop.dispose()
  expect(f.refresh).toHaveBeenCalledOnce()
})

it('coalesces concurrent hints and rejects conflicting final cursors', async () => {
  const f = setup()
  let resolve!: () => void
  f.refresh.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  f.refreshLoop.request(3)
  f.refreshLoop.request(3)
  await Promise.resolve()
  f.refreshLoop.request(4)
  expect(f.onError).toHaveBeenCalledOnce()
  expect(f.refresh).toHaveBeenCalledOnce()
  resolve()
  await f.refreshLoop.dispose()
})

it('fences a scheduled refresh on disposal', async () => {
  const f = setup()
  f.refreshLoop.request(0)
  await f.refreshLoop.dispose()
  expect(f.refresh).not.toHaveBeenCalled()
})

it('holds disposal behind an in-flight status request', async () => {
  const f = setup()
  let resolve!: () => void
  f.refresh.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  f.refreshLoop.request(0)
  await Promise.resolve()
  let stopped = false
  const stopping = f.refreshLoop.dispose().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  resolve()
  await stopping
  expect(stopped).toBe(true)
})
