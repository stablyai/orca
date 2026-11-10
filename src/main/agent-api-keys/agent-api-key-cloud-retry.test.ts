import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentApiKeyCloudRetry } from './agent-api-key-cloud-retry'

type Link = 'connected' | 'unreachable' | 'signed-out' | null

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function fakeCloud() {
  const cloud: {
    lastLink: Link
    pending: boolean
    hasPending: () => boolean
    flushPending: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  } = {
    lastLink: null,
    pending: false,
    hasPending: () => cloud.pending,
    flushPending: vi.fn(async () => false)
  }
  return cloud
}

describe('createAgentApiKeyCloudRetry', () => {
  it('runs only when kicked, backs off while Orca is unreachable, and stops once it is back', async () => {
    const cloud = fakeCloud()
    const notify = vi.fn()
    const retry = createAgentApiKeyCloudRetry({
      cloud,
      serial: (run) => run(),
      notify,
      firstDelayMs: 10,
      maxDelayMs: 40
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(cloud.flushPending).not.toHaveBeenCalled()

    cloud.lastLink = 'unreachable'
    retry.kick()
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.flushPending).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(19)
    expect(cloud.flushPending).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cloud.flushPending).toHaveBeenCalledTimes(2)

    cloud.flushPending.mockImplementationOnce(async () => {
      cloud.lastLink = 'connected'
      return true
    })
    await vi.advanceTimersByTimeAsync(40)
    expect(cloud.flushPending).toHaveBeenCalledTimes(3)
    expect(notify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cloud.flushPending).toHaveBeenCalledTimes(3)
    retry.stop()
  })

  it('a soon kick (wake, start) resets the backoff', async () => {
    const cloud = fakeCloud()
    cloud.pending = true
    const retry = createAgentApiKeyCloudRetry({
      cloud,
      serial: (run) => run(),
      notify: () => {},
      firstDelayMs: 10,
      maxDelayMs: 1000
    })
    retry.kick()
    await vi.advanceTimersByTimeAsync(10 + 20 + 40)
    expect(cloud.flushPending).toHaveBeenCalledTimes(3)
    retry.kick({ soon: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.flushPending).toHaveBeenCalledTimes(4)
    retry.stop()
  })
})
