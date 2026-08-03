import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationSetupPollController } from './dictation-setup-poll-controller'

const POLL_INTERVAL_MS = 1500

async function flushPromises(): Promise<void> {
  // Why: the refresh mock wraps its result in `.finally()` and the resume path chains
  // runRefresh → requestRefresh → runRefresh, so the follow-up refresh is several microtask
  // hops deep — drain generously rather than a fixed two ticks.
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

  it('does not refresh while hidden, unfocused, or backgrounded', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)

    poller.setForeground(true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(refresh).not.toHaveBeenCalled()

    poller.setVisible(true)
    expect(refresh).toHaveBeenCalledOnce()
    await flushPromises()
    poller.setVisible(false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(refresh).toHaveBeenCalledOnce()

    poller.setVisible(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    await flushPromises()
    poller.setForeground(false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(2)

    poller.dispose()
  })

  it('keeps slow refreshes single-flight and waits a full delay after each response', async () => {
    const requests = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()]
    let active = 0
    let maxActive = 0
    const refresh = vi.fn(() => {
      const request = requests[refresh.mock.calls.length - 1]
      active += 1
      maxActive = Math.max(maxActive, active)
      return request.promise.finally(() => {
        active -= 1
      })
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
    expect(maxActive).toBe(1)

    requests[2].resolve(false)
    await flushPromises()
    poller.dispose()
  })

  it('coalesces an immediate resume refresh behind a slow request', async () => {
    const requests = [deferred<boolean>(), deferred<boolean>()]
    let active = 0
    let maxActive = 0
    const refresh = vi.fn(() => {
      const request = requests[refresh.mock.calls.length - 1]
      active += 1
      maxActive = Math.max(maxActive, active)
      return request.promise.finally(() => {
        active -= 1
      })
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
    expect(maxActive).toBe(1)

    requests[1].resolve(false)
    await flushPromises()
    poller.dispose()
  })

  it('refreshes immediately when visibility or foreground eligibility resumes', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)
    poller.setVisible(true)
    poller.setForeground(true)
    expect(refresh).toHaveBeenCalledOnce()
    await flushPromises()

    poller.setForeground(false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    poller.setForeground(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    await flushPromises()

    poller.setVisible(false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    poller.setVisible(true)
    expect(refresh).toHaveBeenCalledTimes(3)

    poller.dispose()
  })

  it('stops after setup leaves the download or extraction lifecycle', async () => {
    const refresh = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const poller = new DictationSetupPollController(refresh, POLL_INTERVAL_MS)
    poller.setPolling(true)
    poller.setVisible(true)
    poller.setForeground(true)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

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

    // Explicit stop lands while the read is still on the wire.
    poller.setPolling(false)
    // The stale read then resolves "keep polling" — the fence must drop it, not restart the poll.
    request.resolve(true)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    poller.dispose()
  })
})
