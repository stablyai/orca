import { expect, it } from 'vitest'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { ConnectorSnapshotTrace } from './connector-snapshot-trace'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FAKE_BOT, fakeSeam } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()

it('correlates changed-input and poll-conflict snapshots from the same client with their accepted hellos', async () => {
  const spans: { name: string; attributes: Record<string, unknown> }[] = []
  const events = new ConnectorTurnEvents(
    h.userDataPath,
    'ada',
    new ConnectorSnapshotTrace((name, attributes) => spans.push({ name, attributes }))
  )
  const { client, machine } = h.startClient(fakeSeam(), events)
  try {
    await settle()
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle()
    h.poll([])
    await settle()
    h.fake.answerPoll({ status: 409 })
    await settle()

    const built = spans.filter((span) => span.name === 'connector.snapshot.built')
    expect(built.map((span) => span.attributes.reason)).toEqual([
      'client-start',
      'first',
      'inputs-changed',
      'poll-409'
    ])
    expect(new Set(built.map((span) => span.attributes.clientId)).size).toBe(1)
    expect(
      spans
        .filter((span) => span.name === 'connector.snapshot.sent')
        .map((span) => ({ outcome: span.attributes.outcome, helloRev: span.attributes.helloRev }))
    ).toEqual([
      { outcome: 'never-sent', helloRev: null },
      { outcome: 'accepted', helloRev: 1 },
      { outcome: 'accepted', helloRev: 2 },
      { outcome: 'accepted', helloRev: 3 }
    ])
  } finally {
    client.stop()
    events.clear()
  }
})
