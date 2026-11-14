import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserClientHostAuthorityReplacementWait } from './browser-client-host-authority-replacement-wait'

describe('BrowserClientHostAuthorityReplacementWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires exactly once, at the grace deadline', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const expire = vi.fn()

    wait.arm(expire)

    expect(wait.armed).toBe(true)
    vi.advanceTimersByTime(999)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledOnce()
    expect(wait.armed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(expire).toHaveBeenCalledOnce()
  })

  // Bursts of mismatch errors must not postpone retirement indefinitely.
  it('keeps the first deadline when armed again while already armed', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const first = vi.fn()
    const second = vi.fn()

    wait.arm(first)
    vi.advanceTimersByTime(900)
    wait.arm(second)
    vi.advanceTimersByTime(100)

    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
  })

  it('never expires after a cancel', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const expire = vi.fn()
    wait.arm(expire)

    wait.cancel()

    expect(wait.armed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(expire).not.toHaveBeenCalled()
  })

  it('is re-armable after a cancel and after an expiry', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const cancelled = vi.fn()
    const rearmed = vi.fn()
    wait.arm(cancelled)
    wait.cancel()

    wait.arm(rearmed)
    vi.advanceTimersByTime(1_000)

    expect(cancelled).not.toHaveBeenCalled()
    expect(rearmed).toHaveBeenCalledOnce()

    const afterExpiry = vi.fn()
    wait.arm(afterExpiry)
    vi.advanceTimersByTime(1_000)
    expect(afterExpiry).toHaveBeenCalledOnce()
  })
})
