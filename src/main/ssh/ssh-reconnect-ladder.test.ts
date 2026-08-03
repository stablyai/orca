import { describe, expect, it } from 'vitest'
import { MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../shared/ssh-types'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-utils'
import {
  FLAP_DELAY_CAP_MS,
  RELAY_REESTABLISH_BUDGET_MS,
  SshReconnectLadder,
  STABLE_CONNECTION_MS
} from './ssh-reconnect-ladder'

describe('SshReconnectLadder', () => {
  it('climbs the table across consecutive post-handshake drops', () => {
    const ladder = new SshReconnectLadder()

    ladder.markConnected(0)
    expect(ladder.next(50)).toEqual({ kind: 'retry', delayMs: 1000, attemptIndex: 0 })
    ladder.markConnected(60)
    expect(ladder.next(110)).toEqual({ kind: 'retry', delayMs: 2000, attemptIndex: 1 })

    // Table steps past FLAP_DELAY_CAP_MS are clamped so the retry still fits inside the relay grace floor.
    const rest = [5000, 5000, 10000, 10000, 10000, 30000, 30000]
    let now = 200
    rest.forEach((delayMs, index) => {
      ladder.markConnected(now)
      now += 50
      expect(ladder.next(now)).toEqual({
        kind: 'retry',
        delayMs: Math.min(delayMs, FLAP_DELAY_CAP_MS),
        attemptIndex: index + 2
      })
    })

    // Saturates at the last step instead of going terminal.
    for (let i = 0; i < 3; i++) {
      ladder.markConnected(now)
      now += 50
      expect(ladder.next(now)).toEqual({
        kind: 'retry',
        delayMs: Math.min(30000, FLAP_DELAY_CAP_MS),
        attemptIndex: 8
      })
    }
  })

  it('caps every flap delay so handshake and relay re-establishment beat grace', () => {
    const ladder = new SshReconnectLadder()
    let now = 0

    for (let i = 0; i < RECONNECT_BACKOFF_MS.length + 4; i++) {
      ladder.markConnected(now)
      now += 50
      const decision = ladder.next(now)
      expect(decision.kind).toBe('retry')
      if (decision.kind === 'retry') {
        expect(decision.delayMs + CONNECT_TIMEOUT_MS + RELAY_REESTABLISH_BUDGET_MS).toBeLessThan(
          MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
        )
        now += decision.delayMs
      }
    }
    expect(FLAP_DELAY_CAP_MS).toBe(5_000)
  })

  it('keeps the uncapped table for a host whose handshakes fail', () => {
    const ladder = new SshReconnectLadder()
    const delays: number[] = []

    for (let i = 0; i < RECONNECT_BACKOFF_MS.length - 1; i++) {
      ladder.markAttemptFailed()
      const decision = ladder.next(i * 1000)
      if (decision.kind === 'retry') {
        delays.push(decision.delayMs)
      }
      expect(ladder.failedAttemptStreak).toBe(i + 1)
    }

    expect(delays).toEqual(RECONNECT_BACKOFF_MS.slice(0, -1))
    expect(delays.some((delayMs) => delayMs > FLAP_DELAY_CAP_MS)).toBe(true)
  })

  it('escalates a post-handshake drop identically to a handshake failure', () => {
    const dropLadder = new SshReconnectLadder()
    const failureLadder = new SshReconnectLadder()
    const dropDelays: number[] = []
    const dropIndexes: number[] = []
    const failureIndexes: number[] = []

    let now = 0
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      dropLadder.markConnected(now)
      now += 50
      const dropDecision = dropLadder.next(now)
      const failureDecision = failureLadder.next(now)
      expect(dropDecision.kind).toBe('retry')
      expect(failureDecision.kind).toBe('retry')
      if (dropDecision.kind === 'retry') {
        dropDelays.push(dropDecision.delayMs)
        dropIndexes.push(dropDecision.attemptIndex)
      }
      if (failureDecision.kind === 'retry') {
        failureIndexes.push(failureDecision.attemptIndex)
      }
      failureLadder.markAttemptFailed()
      now += 50
    }

    // Same ladder position; the flap path only clamps the wall-clock delay to the grace budget.
    expect(dropIndexes).toEqual(failureIndexes)
    expect(dropDelays).toEqual(RECONNECT_BACKOFF_MS.map((d) => Math.min(d, FLAP_DELAY_CAP_MS)))
  })

  it('never reaches give-up on a flap streak, even with a later handshake failure', () => {
    const ladder = new SshReconnectLadder()
    let now = 0
    for (let i = 0; i < 12; i++) {
      ladder.markConnected(now)
      now += 50
      const decision = ladder.next(now)
      expect(decision.kind).toBe('retry')
      if (decision.kind === 'retry') {
        now += decision.delayMs
      }
    }

    ladder.markAttemptFailed()

    expect(ladder.next(now)).toEqual({ kind: 'retry', delayMs: 30000, attemptIndex: 8 })
  })

  it('gives up only after RECONNECT_BACKOFF_MS.length consecutive failed attempts', () => {
    const ladder = new SshReconnectLadder()
    const decisions: string[] = []

    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      ladder.markAttemptFailed()
      decisions.push(ladder.next(i * 1000).kind)
    }

    expect(decisions.slice(0, RECONNECT_BACKOFF_MS.length - 1)).toEqual(
      Array(RECONNECT_BACKOFF_MS.length - 1).fill('retry')
    )
    expect(decisions.at(-1)).toBe('give-up')
  })

  it('resets the delay ladder exactly once for a stable connection', () => {
    const ladder = new SshReconnectLadder()
    for (let i = 0; i < 5; i++) {
      ladder.next(i)
    }

    ladder.markConnected(0)
    expect(ladder.next(STABLE_CONNECTION_MS)).toEqual({
      kind: 'retry',
      delayMs: 1000,
      attemptIndex: 0
    })
    // The consumed timestamp must not reset the ladder again later in the same outage.
    expect(ladder.next(STABLE_CONNECTION_MS * 4)).toEqual({
      kind: 'retry',
      delayMs: 2000,
      attemptIndex: 1
    })
  })

  it('does not let a dead host self-reset past the give-up bound', () => {
    const ladder = new SshReconnectLadder()
    ladder.markConnected(0)

    let now = 0
    let last = ladder.next(now)
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      ladder.markAttemptFailed()
      now += STABLE_CONNECTION_MS * 2
      last = ladder.next(now)
    }

    expect(last).toEqual({ kind: 'give-up' })
  })

  it('returns to the head of the ladder after reset()', () => {
    const ladder = new SshReconnectLadder()
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      ladder.markAttemptFailed()
      ladder.next(i)
    }

    ladder.reset()

    expect(ladder.next(0)).toEqual({ kind: 'retry', delayMs: 1000, attemptIndex: 0 })
  })
})
