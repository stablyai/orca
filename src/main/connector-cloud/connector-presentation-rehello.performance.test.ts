import { expect, it, onTestFinished } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE,
  SlackAnswerPresentationSchema,
  slackAnswerText
} from '../../shared/connectors/slack-answer-presentation'
import {
  conversation,
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FAKE_BOT } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()
const presentation = SlackAnswerPresentationSchema.parse({
  v: 1,
  text: 'West led.',
  visual: {
    kind: 'bar',
    title: 'Sales',
    axis: 'Region',
    unit: 'USD',
    source: 'regional-sales.csv',
    labels: ['East', 'West'],
    series: [{ label: 'Sales', values: [12, 20] }]
  }
})
const text = slackAnswerText(presentation)

// #49372: mixed ingress restaged the entire bot inventory after each burst of direct rejections.
it.each([
  { bots: 100, pages: 5 },
  { bots: 1_000, pages: 50 }
])('bounds mixed receiver refresh work with $bots bots and posts', async ({ bots, pages }) => {
  h.fake.features = [
    'bots.pages',
    CONNECTOR_SLACK_PRESENTATION_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  const owed = new ConnectorTurnEvents(h.userDataPath, 'ada')
  const { client, emit } = h.startClient(undefined, owed, (machine) => {
    machine.botList = Array.from({ length: bots }, (_, index) => ({
      ...FAKE_BOT,
      id: `bot-${index}`
    }))
  })
  onTestFinished(() => client.stop())
  await settle()
  expect(h.fake.registeredBots).toHaveLength(bots)
  h.fake.requests.length = 0
  h.fake.events.length = 0
  const work = () => ({
    hellos: h.fake.requestsTo(CONNECTOR_PATHS.hello).length,
    pages: h.fake.requestsTo(CONNECTOR_PATHS.botPages).length,
    snapshots: h.fake
      .requestsTo(CONNECTOR_PATHS.events)
      .filter(
        ({ body }) =>
          isRecord(body) &&
          Array.isArray(body.events) &&
          body.events.some((event: unknown) => isRecord(event) && event.kind === 'snapshot')
      ).length
  })
  h.fake.forced.set(CONNECTOR_PATHS.replies, { status: 400, body: { error: 'invalid_request' } })
  const reply = (replyId: string) =>
    client.reply({ replyId, conversation, turnId: SERVER_NOW, text, presentation })
  await expect(reply('first')).resolves.toMatchObject({ ok: false, status: 400 })
  await settle()
  expect(work()).toEqual({ hellos: 1, pages, snapshots: 1 })

  h.fake.refusePresentedEvents = true
  emit({
    kind: 'turn-ended',
    conversation,
    worktreeId: 'w1',
    paneKey: 'p1',
    turnId: SERVER_NOW,
    at: SERVER_NOW,
    stopReason: 'success',
    lastAssistantMessage: text,
    presentation
  })
  const ids = Array.from({ length: bots }, (_, index) => `reply-${index}`)
  const burst = Promise.all(ids.map(reply))
  await settle()
  expect(work()).toEqual({ hellos: 1, pages, snapshots: 1 })
  expect(owed.turnEndPending(conversation, SERVER_NOW)).toBe(true)

  await settle(30_000)
  expect((await burst).every((result) => !result.ok && result.status === 400)).toBe(true)
  expect(work()).toEqual({ hellos: 2, pages: 2 * pages, snapshots: 2 })
  expect(owed.turnEndPending(conversation, SERVER_NOW)).toBe(true)
  const sent = h.fake.requestsTo(CONNECTOR_PATHS.replies).map(({ body }) => body)
  expect(sent).toHaveLength(2 * (bots + 1))
  expect(new Set(sent.map((body) => isRecord(body) && body.replyId))).toEqual(
    new Set(['first', ...ids])
  )
  expect(sent.every((body) => isRecord(body) && body.v === 2 && body.text === text)).toBe(true)

  h.fake.refusePresentedEvents = false
  await settle(30_000)
  expect(work()).toEqual({ hellos: 3, pages: 3 * pages, snapshots: 3 })
  expect(owed.turnEndPending(conversation, SERVER_NOW)).toBe(false)
  expect(h.fake.events.filter((event) => isRecord(event) && event.kind === 'turn-ended')).toEqual([
    expect.objectContaining({
      conversation,
      turnId: SERVER_NOW,
      lastAssistantMessage: text,
      presentation
    })
  ])
})
