import { expect, it } from 'vitest'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorReach } from './connector-reach'

const noAnswer: ConnectorFailure = { ok: false, status: null, error: null, retryAfterMs: null }
const answered = { ok: true as const, value: null }

it('treats the poll answering after a missed outside call as the cloud back, once per run of misses', () => {
  const reach = new ConnectorReach(() => {})
  let backs = 0
  reach.onBack(() => backs++)

  // A picture's call got no answer while the poll stayed healthy: the poll's next answer is the step.
  reach.missedOutsidePoll(noAnswer)
  reach.reached(answered)
  expect(backs).toBe(1)
  reach.reached(answered)
  expect(backs).toBe(1)

  // Its retry missed too: it waits for another real step, not the poll's pace.
  reach.missedOutsidePoll({ ...noAnswer, status: 503 })
  reach.reached(answered)
  expect(backs).toBe(1)

  // Once an outside call is answered, the next miss gets its one retry again.
  reach.missedOutsidePoll(answered)
  reach.missedOutsidePoll(noAnswer)
  reach.reached(answered)
  expect(backs).toBe(2)
})
