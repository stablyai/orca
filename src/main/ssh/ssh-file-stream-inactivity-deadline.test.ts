import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSshFileStreamInactivityDeadline } from './ssh-file-stream-inactivity-deadline'
import type { SystemPowerLifecycleListener } from '../system-power-lifecycle'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SSH file stream inactivity timer', () => {
  it('reuses one timer while retaining the deadline of the latest chunk', () => {
    vi.useFakeTimers()
    const allocate = vi.spyOn(globalThis, 'setTimeout')
    const onTimeout = vi.fn()
    const unsubscribe = vi.fn()
    const deadline = createSshFileStreamInactivityDeadline(onTimeout, (listener) => {
      listener.onResume()
      return unsubscribe
    })
    deadline.reset()
    vi.advanceTimersByTime(30_000)
    for (let chunk = 0; chunk < 1000; chunk += 1) {
      deadline.reset()
    }
    expect(allocate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(59_999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    deadline.clear()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases on suspend and creates a fresh timer on resume', () => {
    vi.useFakeTimers()
    const allocate = vi.spyOn(globalThis, 'setTimeout')
    const onTimeout = vi.fn()
    let power!: SystemPowerLifecycleListener
    const deadline = createSshFileStreamInactivityDeadline(onTimeout, (listener) => {
      power = listener
      listener.onResume()
      return vi.fn()
    })
    deadline.reset()
    vi.advanceTimersByTime(30_000)
    power.onSuspend()
    for (let chunk = 0; chunk < 1000; chunk += 1) {
      deadline.reset()
    }
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(onTimeout).not.toHaveBeenCalled()
    power.onResume()
    expect(allocate).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(59_999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    deadline.clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer and subscription and supports a later reset', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((listener: SystemPowerLifecycleListener) => {
      listener.onResume()
      return unsubscribe
    })
    const deadline = createSshFileStreamInactivityDeadline(onTimeout, subscribe)
    deadline.reset()
    deadline.clear()
    deadline.clear()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(onTimeout).not.toHaveBeenCalled()
    deadline.reset()
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    deadline.clear()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
