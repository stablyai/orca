import { describe, expect, it } from 'vitest'
import { MIN_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../shared/ssh-types'
import { CONNECT_TIMEOUT_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-utils'
import { FLAP_DELAY_CAP_MS, RELAY_REESTABLISH_BUDGET_MS } from './ssh-reconnect-ladder'
import { SSH_PTY_OPEN_CLIENT_TIMEOUT_MS } from './ssh-pty-consumer-session'
import { SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS } from './ssh-relay-session'

/**
 * FLAP_DELAY_CAP_MS decides how long the client may wait before retrying a flap, and it is derived
 * from RELAY_REESTABLISH_BUDGET_MS — a hardcoded 20_000 whose comment says it covers "existing-relay
 * attach and one bounded PTY reattach, 10s each". Nothing tied that literal to either deadline.
 *
 * The failure mode is silent and total: if reattach grows past the budget, the ladder retries after
 * the remote relay's grace has already expired, so the relay shuts down and takes every remote PTY
 * with it. No error, no reconnect — the user's sessions are simply gone. The client is guessing at a
 * window the daemon owns, so at minimum that guess must stay pessimistic.
 */
describe('relay re-establish budget', () => {
  it('covers both deadlines a reconnect must fit before grace expires', () => {
    expect(RELAY_REESTABLISH_BUDGET_MS).toBeGreaterThanOrEqual(
      SSH_PTY_OPEN_CLIENT_TIMEOUT_MS + SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS
    )
  })

  it('leaves a full connect attempt inside the shortest configurable grace', () => {
    // Why >, not >=: at equality the retry lands exactly as grace expires, and which side wins is
    // a race on the two clocks rather than a decision.
    expect(MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000).toBeGreaterThan(
      CONNECT_TIMEOUT_MS + RELAY_REESTABLISH_BUDGET_MS
    )
  })

  it('caps a flap retry early enough to still re-establish', () => {
    expect(FLAP_DELAY_CAP_MS + CONNECT_TIMEOUT_MS + RELAY_REESTABLISH_BUDGET_MS).toBeLessThan(
      MIN_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    )
  })

  it('keeps the cap meaningful — it must actually shorten some table delay', () => {
    // Why: if every backoff step already fits, the cap is dead code and a later table change could
    // reintroduce the unbounded wait without anything failing here.
    expect(RECONNECT_BACKOFF_MS.some((delayMs) => delayMs > FLAP_DELAY_CAP_MS)).toBe(true)
    expect(RECONNECT_BACKOFF_MS).toContain(FLAP_DELAY_CAP_MS)
  })
})
