import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserScreencastFrameCredit } from './browser-screencast-frame-credit'

describe('createBrowserScreencastFrameCredit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('permits 3 frames in flight before an ack and resumes once acknowledged', () => {
    const onCreditAvailable = vi.fn()
    const credit = createBrowserScreencastFrameCredit({ onCreditAvailable })

    expect(credit.canSend()).toBe(true)
    credit.recordSent(1)
    expect(credit.canSend()).toBe(true)
    credit.recordSent(2)
    expect(credit.canSend()).toBe(true)
    credit.recordSent(3)
    expect(credit.canSend()).toBe(false)

    vi.advanceTimersByTime(40)
    credit.acknowledge(2)
    expect(onCreditAvailable).toHaveBeenCalledTimes(1)
    expect(credit.canSend()).toBe(true)

    credit.dispose()
  })
})
