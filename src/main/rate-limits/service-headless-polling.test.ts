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
    const inactive = vi
      .spyOn(service, 'fetchInactiveClaudeAccountsOnOpen')
      .mockResolvedValue(undefined)
    const options = { fetchImmediately: true, pollWithoutWindow: true }
    service.start(options)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(3)
    expect(inactive).not.toHaveBeenCalled()

    service.stop()
    expect(service.canBackgroundPoll()).toBe(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(3)

    service.start({ fetchImmediately: true })
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(4)
  })

  it('reads inactive Claude accounts on each headless poll when asked', async () => {
    const inactive = vi
      .spyOn(service, 'fetchInactiveClaudeAccountsOnOpen')
      .mockResolvedValue(undefined)
    service.start({
      fetchImmediately: true,
      pollWithoutWindow: true,
      pollInactiveClaude: true
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(service.fetches).toHaveBeenCalledTimes(3)
    expect(inactive).toHaveBeenCalledTimes(3)

    service.stop()
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    expect(inactive).toHaveBeenCalledTimes(3)
  })

  it.each(['focused', 'visible', 'minimized'] as const)(
    'keeps the attached desktop window %s gate unless headless polling is opted in',
    async (field) => {
      const window = new FakeRateLimitWindow()
      window[field] = field === 'minimized'
      service.attach(asRateLimitWindow(window))
      service.start({ fetchImmediately: true })
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
      expect(service.fetches).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['focused', 'visible', 'minimized'] as const)(
    'polls an attached %s window when headless polling is opted in',
    async (field) => {
      const inactive = vi
        .spyOn(service, 'fetchInactiveClaudeAccountsOnOpen')
        .mockResolvedValue(undefined)
      const window = new FakeRateLimitWindow()
      window[field] = field === 'minimized'
      service.attach(asRateLimitWindow(window))
      service.start({
        fetchImmediately: true,
        pollWithoutWindow: true,
        pollInactiveClaude: true
      })
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
      expect(service.fetches).toHaveBeenCalledTimes(3)
      expect(inactive).toHaveBeenCalledTimes(3)
    }
  )
})
