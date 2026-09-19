import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PtyOwnershipCaptureIngressFence } from './pty-ownership-capture-ingress-fence'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('revokes expired authority and reports failed resume without throwing from the timer', () => {
  const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const resume = vi.fn(() => {
    throw new Error('resume failed')
  })
  const fence = new PtyOwnershipCaptureIngressFence(vi.fn(), resume)
  const lease = fence.begin(() => true)
  expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
  expect(lease.isCurrent()).toBe(false)
  expect(fence.held).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('expiry_resume_failed'))
  lease.release()
  expect(resume).toHaveBeenCalledOnce()
})

it('preserves both pause and cleanup failures after revoking the lease', () => {
  const pauseError = new Error('pause failed')
  const resumeError = new Error('resume failed')
  const fence = new PtyOwnershipCaptureIngressFence(
    () => {
      throw pauseError
    },
    () => {
      throw resumeError
    }
  )
  let failure: unknown
  try {
    fence.begin(() => true)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([pauseError, resumeError])
  expect(fence.held).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('permanently invalidates a capture when its ownership check throws', () => {
  const pause = vi.fn()
  const resume = vi.fn()
  const fence = new PtyOwnershipCaptureIngressFence(pause, resume)
  const authorized = vi.fn(() => true)
  const lease = fence.begin(authorized)
  authorized.mockImplementationOnce(() => {
    throw new Error('owner unavailable')
  })
  expect(lease.isCurrent()).toBe(false)
  expect(lease.isCurrent()).toBe(false)
  expect(fence.held).toBe(true)
  lease.release()
  expect(resume).toHaveBeenCalledOnce()
})

it('cleans up a failed native pause so the same terminal can retry', () => {
  const pause = vi.fn().mockImplementationOnce(() => {
    throw new Error('pause failed')
  })
  const resume = vi.fn()
  const fence = new PtyOwnershipCaptureIngressFence(pause, resume)
  expect(() => fence.begin(() => true)).toThrow('pause failed')
  expect(fence.held).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  const lease = fence.begin(() => true)
  expect(lease.isCurrent()).toBe(true)
  lease.release()
  expect(resume).toHaveBeenCalledTimes(2)
})

it('refuses overlapping capture and cancels timers on terminal disposal', () => {
  const resume = vi.fn()
  const fence = new PtyOwnershipCaptureIngressFence(vi.fn(), resume)
  const lease = fence.begin(() => true)
  expect(() => fence.begin(() => true)).toThrow('unavailable')
  fence.dispose()
  expect(lease.isCurrent()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(() => fence.begin(() => true)).toThrow('unavailable')
  lease.release()
  expect(resume).not.toHaveBeenCalled()
})

it.each([0, -1, 30_001, Number.NaN, Infinity, 0.5])(
  'rejects invalid timeout %s before pausing',
  (timeout) => {
    const pause = vi.fn()
    const fence = new PtyOwnershipCaptureIngressFence(pause, vi.fn())
    expect(() => fence.begin(() => true, timeout)).toThrow('unavailable')
    expect(pause).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
)
