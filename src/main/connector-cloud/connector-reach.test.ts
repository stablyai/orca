import { expect, it } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-paths'
import type { ConnectorFailure } from './connector-cloud-request'
import { type ConnectorBack, ConnectorReach } from './connector-reach'

const noAnswer: ConnectorFailure = { ok: false, status: null, error: null, retryAfterMs: null }
const answered = { ok: true as const, value: null }

it('lets only the poll say the cloud answered, and only its own outage say it recovered', () => {
  const reach = new ConnectorReach(() => {})
  const backs: ConnectorBack[] = []
  reach.onBack((why) => backs.push(why))

  reach.reached(answered, CONNECTOR_PATHS.poll)
  expect(backs).toEqual(['answered'])

  // The events outbox failing, then answering, is neither: nor does it make the poll's next answer a recovery.
  reach.reached({ ...noAnswer, status: 503 }, CONNECTOR_PATHS.events)
  reach.reached(answered, CONNECTOR_PATHS.events)
  reach.reached(answered, CONNECTOR_PATHS.poll)
  expect(backs).toEqual(['answered', 'answered'])

  // The poll's own outage ending is a recovery; a refusal from it is no answer for a picture.
  reach.reached(noAnswer, CONNECTOR_PATHS.poll)
  reach.reached({ ...noAnswer, status: 409 }, CONNECTOR_PATHS.poll)
  reach.reached(answered, CONNECTOR_PATHS.poll)
  expect(backs).toEqual(['answered', 'answered', 'recovered'])
  // A stop says nothing, and an outage that spans it still ends in a recovery.
  reach.reached(noAnswer, CONNECTOR_PATHS.poll)
  reach.stopped()
  expect(backs).toHaveLength(3)
  reach.reached(answered, CONNECTOR_PATHS.poll)
  expect(backs).toEqual(['answered', 'answered', 'recovered', 'recovered'])
})

it('counts a sign-in that also switched the account once', async () => {
  const reach = new ConnectorReach(() => {})
  const backs: ConnectorBack[] = []
  reach.onBack((why) => backs.push(why))
  reach.back('signedIn')
  reach.back('signedIn')
  expect(backs).toEqual(['signedIn'])
  await Promise.resolve()
  reach.back('signedIn')
  expect(backs).toEqual(['signedIn', 'signedIn'])
})
