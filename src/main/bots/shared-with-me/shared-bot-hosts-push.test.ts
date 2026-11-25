import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharedBotHostsPush } from './shared-bot-hosts-push'

describe('shares_changed push', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the shares once for a burst of pushes, and again for a later one', async () => {
    const refresh = vi.fn(async () => {})
    const push = new SharedBotHostsPush(refresh)
    push.changed()
    push.changed()
    await vi.advanceTimersByTimeAsync(200)
    push.changed()
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    push.changed()
    await vi.advanceTimersByTimeAsync(500)
    expect(refresh).toHaveBeenCalledTimes(2)
    push.changed()
    push.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
