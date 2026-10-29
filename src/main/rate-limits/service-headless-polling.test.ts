import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { DEFAULT_POLL_MS } from './service/service-types'
import { asRateLimitWindow, FakeRateLimitWindow } from './rate-limit-service-test-harness'

class PollingProbe extends RateLimitService {
  protected override fetchAll = vi.fn(async () => {})

  get fetches() {
    return this.fetchAll
  }

  canBackgroundPoll(): boolean {
    return this.shouldBackgroundPoll()
  }
}

describe('headless rate-limit polling', () => {
  let service: PollingProbe
  beforeEach(() => {
    vi.useFakeTimers()
    service = new PollingProbe()
  })
  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it('fetches once without a window unless explicitly opted in', async () => {
    service.start({ fetchImmediately: true })
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(1)
  })

  it('polls repeatedly when opted in, stops, and clears the opt-in before restart', async () => {
    const options = { fetchImmediately: true, pollWithoutWindow: true }
    service.start(options)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(3)

    service.stop()
    expect(service.canBackgroundPoll()).toBe(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(3)

    service.start({ fetchImmediately: true })
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(4)
  })

  it.each(['focused', 'visible', 'minimized'] as const)(
    'preserves the attached desktop window %s gate even when opted in',
    async (field) => {
      const window = new FakeRateLimitWindow()
      window[field] = field === 'minimized'
      service.attach(asRateLimitWindow(window))
      const options = { fetchImmediately: true, pollWithoutWindow: true }
      service.start(options)
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
      expect(service.fetches).toHaveBeenCalledTimes(1)
    }
  )
})
