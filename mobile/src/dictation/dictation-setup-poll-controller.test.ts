import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationSetupPollController } from './dictation-setup-poll-controller'

const POLL_INTERVAL_MS = 1500

async function flushPromises(): Promise<void> {
  // Refresh chains finally → requestRefresh → runRefresh; drain enough microtasks to reach the follow-up read.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((next) => {
      resolve = next
    }),
    resolve
  }
}

describe('DictationSetupPollController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps slow refreshes single-flight and waits a full delay after each response', async () => {
    const requests = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()]
    const refresh = vi.fn(() => {
      const request = requests[refresh.mock.calls.length - 1]
      return request.promise
    })
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)
    poller.setVisible(true)
    poller.setForeground(true)

    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledOnce()

    requests[0].resolve(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledTimes(2)

    requests[1].resolve(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(3)

    requests[2].resolve(false)
    await flushPromises()
    poller.dispose()
  })

  it('coalesces an immediate resume refresh behind a slow request', async () => {
    const requests = [deferred<boolean>(), deferred<boolean>()]
    const refresh = vi.fn(() => {
      const request = requests[refresh.mock.calls.length - 1]
      return request.promise
    })
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)
    poller.setVisible(true)
    poller.setForeground(true)

    poller.setForeground(false)
    poller.setForeground(true)
    expect(refresh).toHaveBeenCalledOnce()

    requests[0].resolve(true)
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(2)

    requests[1].resolve(false)
    await flushPromises()
    poller.dispose()
  })

  it('does not resurrect polling when an in-flight refresh resolves true after setPolling(false)', async () => {
    const request = deferred<boolean>()
    const refresh = vi.fn(() => request.promise)
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)
    poller.setVisible(true)
    poller.setForeground(true)
    expect(refresh).toHaveBeenCalledOnce()

    poller.setPolling(false)
    request.resolve(true)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    poller.dispose()
  })
})
