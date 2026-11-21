import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectorPollDropReason, obeyConnectorPollControl } from './connector-poll-control'

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

describe('connectorPollDropReason', () => {
  it('names a feature change’s refusal apart from other 409s and lost answers', () => {
    const refusal = { ok: false as const, error: 'hello_required', retryAfterMs: null }
    expect(connectorPollDropReason({ ...refusal, status: 409, reason: 'features' })).toBe(
      'poll-409-features'
    )
    expect(connectorPollDropReason({ ...refusal, status: 409 })).toBe('poll-409')
    expect(connectorPollDropReason({ ...refusal, status: null, error: null })).toBe('poll-failed')
  })
})
