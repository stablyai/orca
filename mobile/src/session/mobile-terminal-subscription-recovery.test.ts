import { describe, expect, it, vi } from 'vitest'
import { recoverMobileTerminalSubscription } from './mobile-terminal-subscription-recovery'

function makeHarness(current = true, attempt = 0) {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn()
  const schedule = vi.fn<(action: () => void, delayMs: number) => void>()
  recoverMobileTerminalSubscription({
    handle: 'term-1',
    attempt,
    unsubscribe,
    subscribe,
    isCurrent: () => current,
    schedule
  })
  return { schedule, subscribe, unsubscribe }
}

describe('recoverMobileTerminalSubscription', () => {
  it('releases the failed stream and schedules one retry', () => {
    const { schedule, subscribe, unsubscribe } = makeHarness()

    expect(unsubscribe).toHaveBeenCalledWith('term-1')
    expect(schedule).toHaveBeenCalledOnce()
    const [retry, delayMs] = schedule.mock.calls[0]!
    expect(delayMs).toBe(500)
    retry()
    expect(subscribe).toHaveBeenCalledWith('term-1', 1)
  })

  it('backs off a chained recovery attempt', () => {
    const { schedule, subscribe } = makeHarness(true, 4)
    const [retry, delayMs] = schedule.mock.calls[0]!

    expect(delayMs).toBe(8000)
    retry()
    expect(subscribe).toHaveBeenCalledWith('term-1', 5)
  })

  it('drops the retry after the user switches away', () => {
    const { schedule, subscribe } = makeHarness(false)

    schedule.mock.calls[0]![0]()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
