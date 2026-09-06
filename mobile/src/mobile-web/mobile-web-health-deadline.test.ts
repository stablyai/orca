import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebHealthDeadline } from './mobile-web-health-deadline'

afterEach(() => {
  vi.useRealTimers()
})

describe('MobileWebHealthDeadline', () => {
  it('accepts health while init delivery remains unresolved', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const deadline = new MobileWebHealthDeadline(10_000)
    let finishDelivery: (() => void) | undefined
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve
    })

    const postInit = async () => {
      deadline.arm('session-1', expired)
      await delivery
    }
    const posting = postInit()
    deadline.acknowledge('session-1')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(expired).not.toHaveBeenCalled()
    finishDelivery?.()
    await posting
  })

  it('ignores health from a stale session', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const deadline = new MobileWebHealthDeadline(10_000)
    deadline.arm('session-2', expired)

    deadline.acknowledge('session-1')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(expired).toHaveBeenCalledWith('session-2')
  })

  it('replaces an earlier deadline when a new session is armed', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const deadline = new MobileWebHealthDeadline(10_000)
    deadline.arm('session-1', expired)
    deadline.arm('session-2', expired)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(expired).toHaveBeenCalledOnce()
    expect(expired).toHaveBeenCalledWith('session-2')
  })
})
