import { expect, it } from 'vitest'
import type { ConnectorFailure } from './connector-cloud-request'
import { type ConnectorBack, ConnectorReach } from './connector-reach'

const noAnswer: ConnectorFailure = { ok: false, status: null, error: null, retryAfterMs: null }
const answered = { ok: true as const, value: null }

it('treats the poll answering after a missed outside call as the cloud back', () => {
  const reach = new ConnectorReach(() => {})
  const backs: ConnectorBack[] = []
  reach.onBack((why) => backs.push(why))

  // A picture's call got no answer while the poll stayed healthy: the poll's next answer is the step.
  reach.missedOutsidePoll(noAnswer)
  reach.reached(answered)
  reach.reached(answered)
  expect(backs).toEqual(['answered'])

  // A refusal is an answer, not a miss; a poll that still gets none is not the cloud back yet.
  reach.missedOutsidePoll({ ...noAnswer, status: 409 })
  reach.reached(answered)
  reach.missedOutsidePoll({ ...noAnswer, status: 503 })
  reach.reached(noAnswer)
  expect(backs).toEqual(['answered'])
  reach.reached(answered)
  expect(backs).toEqual(['answered', 'answered'])
})
