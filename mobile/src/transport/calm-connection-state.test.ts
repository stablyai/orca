import { describe, expect, it } from 'vitest'
import {
  CALM_STATUS_IDLE,
  CALM_STATUS_REVEAL_DELAY_MS
} from '../../../src/shared/calm-status-reveal'
import { stepCalmConnectionState } from './calm-connection-state'
import type { ConnectionState } from './types'

function present(
  lastConnectedAt: number | null,
  events: { at: number; state: ConnectionState }[]
): ConnectionState[] {
  let reveal = CALM_STATUS_IDLE
  return events.map(({ at, state }) => {
    const step = stepCalmConnectionState(reveal, { state, lastConnectedAt, now: at })
    reveal = step.next
    return step.presented
  })
}

describe('stepCalmConnectionState', () => {
  it('keeps the header connected through a reconnect that heals within the delay', () => {
    expect(
      present(0, [
        { at: 1_000, state: 'reconnecting' },
        { at: 2_000, state: 'handshaking' },
        { at: 3_500, state: 'connected' }
      ])
    ).toEqual(['connected', 'connected', 'connected'])
  })

  it('says Reconnecting once the drop outlasts the delay', () => {
    expect(
      present(0, [
        { at: 1_000, state: 'reconnecting' },
        { at: 1_000 + CALM_STATUS_REVEAL_DELAY_MS, state: 'reconnecting' }
      ])
    ).toEqual(['connected', 'reconnecting'])

    const waiting = stepCalmConnectionState(CALM_STATUS_IDLE, {
      state: 'reconnecting',
      lastConnectedAt: 0,
      now: 1_000
    })
    expect(waiting.recheckInMs).toBe(5_000)
    const almost = stepCalmConnectionState(waiting.next, {
      state: 'reconnecting',
      lastConnectedAt: 0,
      now: 5_999
    })
    expect(almost).toMatchObject({ presented: 'connected', recheckInMs: 1 })
    const revealed = stepCalmConnectionState(almost.next, {
      state: 'reconnecting',
      lastConnectedAt: 0,
      now: 6_000
    })
    expect(revealed).toMatchObject({ presented: 'reconnecting', recheckInMs: null })
  })

  it('shows the first connect and a refused pairing at once', () => {
    expect(present(null, [{ at: 0, state: 'connecting' }])).toEqual(['connecting'])
    expect(present(0, [{ at: 1_000, state: 'auth-failed' }])).toEqual(['auth-failed'])
  })

  it('shows a drop already under way when the screen opens long after the last connect', () => {
    const step = stepCalmConnectionState(CALM_STATUS_IDLE, {
      state: 'reconnecting',
      lastConnectedAt: 0,
      now: 10 * 60_000,
      since: 0
    })
    expect(step.presented).toBe('reconnecting')
  })

  it('keeps a drop that just appeared on screen through its minimum time', () => {
    let reveal = CALM_STATUS_IDLE
    let shown: ConnectionState = 'connected'
    const presented = [
      { at: 1_000, state: 'reconnecting' as const },
      { at: 1_000 + CALM_STATUS_REVEAL_DELAY_MS, state: 'reconnecting' as const },
      { at: 1_010 + CALM_STATUS_REVEAL_DELAY_MS, state: 'connected' as const }
    ].map(({ at, state }) => {
      const step = stepCalmConnectionState(reveal, { state, lastConnectedAt: 0, now: at, shown })
      reveal = step.next
      shown = step.presented
      return step.presented
    })
    expect(presented).toEqual(['connected', 'reconnecting', 'reconnecting'])
  })
})
