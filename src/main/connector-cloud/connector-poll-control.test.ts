import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { obeyConnectorPollControl } from './connector-poll-control'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** How long a drained poll waits before the next one, for one random() draw. */
async function reconnectWaitMs(random: number): Promise<number> {
  const started = Date.now()
  const done = obeyConnectorPollControl(
    { reconnect: true },
    () => random,
    new AbortController().signal
  )
  await vi.runAllTimersAsync()
  await done
  return Date.now() - started
}

describe('obeyConnectorPollControl', () => {
  it('spreads a drain’s re-polls over 0 to 20 s', async () => {
    expect(await reconnectWaitMs(0)).toBe(0)
    expect(await reconnectWaitMs(0.5)).toBe(10_000)
    expect(await reconnectWaitMs(0.999)).toBe(19_980)
  })
})
