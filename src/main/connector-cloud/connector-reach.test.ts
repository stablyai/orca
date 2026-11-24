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

  // A rate limit is a miss too: the cloud may take it when it next answers.
  reach.missedOutsidePoll({ ...noAnswer, status: 429 })
  reach.reached(answered)
  expect(backs).toEqual(['answered', 'answered'])
  backs.length = 1

  // A refusal is an answer, not a miss; a poll that still gets none is not the cloud back yet.
  reach.missedOutsidePoll({ ...noAnswer, status: 409 })
  reach.reached(answered)
  reach.missedOutsidePoll({ ...noAnswer, status: 503 })
  reach.reached(noAnswer)
  expect(backs).toEqual(['answered'])
  // Its own outage recovering is a fresh step, told apart from the answer to a missed call.
  reach.reached(answered)
  expect(backs).toEqual(['answered', 'recovered'])

  // The poll stopping (sign-out, quit, a first connect) is not the cloud back, but a missed call still waits
  // for the next poll's answer.
  reach.missedOutsidePoll(noAnswer)
  reach.reached(noAnswer)
  reach.stopped()
  expect(backs).toEqual(['answered', 'recovered'])
  reach.reached(answered)
  expect(backs).toEqual(['answered', 'recovered', 'answered'])
})
