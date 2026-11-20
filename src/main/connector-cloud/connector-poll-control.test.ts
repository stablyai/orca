import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTOR_REHELLO_SPREAD_MS,
  connectorRehelloSpreadMs,
  obeyConnectorPollControl
} from './connector-poll-control'

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

describe('connectorRehelloSpreadMs', () => {
  it('spreads a 409’s new hello over 0 to 60 s', () => {
    expect(CONNECTOR_REHELLO_SPREAD_MS).toBe(60_000)
    expect(connectorRehelloSpreadMs(() => 0)).toBe(0)
    expect(connectorRehelloSpreadMs(() => 0.5)).toBe(30_000)
    expect(connectorRehelloSpreadMs(() => 0.999)).toBe(59_940)
  })
})
