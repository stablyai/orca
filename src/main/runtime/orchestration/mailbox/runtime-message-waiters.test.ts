import { describe, expect, it, vi } from 'vitest'
import { RuntimeMessageWaiters } from './runtime-message-waiters'

describe('message waiters', () => {
  it("tells when a handle's last wait ends with nothing delivered, never when mail woke it", async () => {
    const ended = vi.fn()
    const waiters = new RuntimeMessageWaiters()
    waiters.onWaitEnded(ended)
    const delivered = waiters.wait('dispatch:ctx_a')
    waiters.notify('dispatch:ctx_a')
    await delivered
    const aborted = new AbortController()
    const first = waiters.wait('dispatch:ctx_b', { signal: aborted.signal })
    const second = waiters.wait('dispatch:ctx_b')
    aborted.abort()
    await first
    await Promise.resolve()
    expect(ended).not.toHaveBeenCalled()
    waiters.cancel('dispatch:ctx_b')
    await second
    await Promise.resolve()
    expect(ended.mock.calls).toEqual([['dispatch:ctx_b']])
  })
})
