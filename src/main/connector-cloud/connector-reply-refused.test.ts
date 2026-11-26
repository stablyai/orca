import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  CONNECTOR_PATHS,
  CONNECTOR_REPLIES_OUTBOX_FEATURE
} from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH,
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE,
  SlackAnswerPresentationSchema,
  SLACK_PRESENTATION_UNCONFIRMED,
  slackAnswerText
} from '../../shared/connectors/slack-answer-presentation'
import type { ConnectorReplyBody } from './connector-replies'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorTurnEvents } from './connector-turn-events'
import { ConnectorEventRequests } from './connector-event-requests'
import { ConnectorOutboxSender } from './connector-outbox'
import {
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const row: JournalConnectorReplyRow = {
  account: 'ada',
  deliveryId: 'd1',
  conversation: { source: 'slack', externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' },
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: 'm1',
  queued: false,
  fill: { outcome: 'answered', answerDeliveryId: 'd1', prose: 'The fix is in.', filledAt: 1 }
}

const refusal = (status: number, error: string): ConnectorFailure => ({
  ok: false,
  status,
  error,
  retryAfterMs: null
})

/** Whether the row goes again under the same hello, and how often it is posted under a next hello
 *  that switched to the /replies route, after the cloud refused it with `failure`. */
async function sentAgainAfter(
  failure: ConnectorFailure
): Promise<{ sameHello: boolean; postedNext: number }> {
  let posted = 0
  const dir = mkdtempSync(join(tmpdir(), 'orca-reply-refused-'))
  dirs.push(dir)
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async () => [row],
      readOwed: async (_account, after) => (after === null ? [row] : []),
      fillOutcomes: async () => false,
      sent: async () => {}
    }),
    onOwed: () => {},
    post: async () => {
      posted += 1
      return { ok: true, value: {} }
    },
    hostName: () => 'laptop'
  })
  events.useCloudFeatures(new Set([CONNECTOR_REPLIES_OUTBOX_FEATURE]))
  events.useReplyFlush(() => {})
  await events.drainReplies()
  const head = events.next(1)
  expect(head?.batch.map((event) => event.kind)).toEqual(['reply'])
  events.refused(head!.stamp, failure)
  await events.drainReplies()
  const sameHello = events.next(1) !== null
  // A new hello, here one that switched replies to /replies, gives it another chance.
  events.useCloudFeatures(new Set())
  events.resetLive()
  await events.drainReplies()
  events.clear()
  return { sameHello, postedNext: posted }
}

it('holds a reply refused as invalid until the next hello, and keeps sending one that does not stand yet', async () => {
  expect(await sentAgainAfter(refusal(400, 'invalid_request'))).toEqual({
    sameHello: false,
    postedNext: 1
  })
  expect(await sentAgainAfter(refusal(503, 'reply_not_accepted'))).toEqual({
    sameHello: true,
    postedNext: 1
  })
})

it('loads the next journal page only once the outbox accepts the current page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reply-pages-'))
  dirs.push(dir)
  const rows = Array.from({ length: 201 }, (_, index): JournalConnectorReplyRow => {
    const deliveryId = `d${String(index).padStart(3, '0')}`
    return {
      ...row,
      deliveryId,
      fill: { ...row.fill!, answerDeliveryId: deliveryId }
    }
  })
  const sent = new Set<string>()
  let reads = 0
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async () => rows,
      readOwed: async (_account, after, limit) => {
        reads += 1
        return rows
          .filter(({ deliveryId }) => !sent.has(deliveryId) && (!after || deliveryId > after))
          .slice(0, limit)
      },
      fillOutcomes: async () => false,
      sent: async (keys) => keys.forEach(({ deliveryId }) => sent.add(deliveryId))
    }),
    onOwed: () => {},
    post: async () => ({ ok: true, value: {} }),
    hostName: () => 'laptop'
  })
  try {
    events.useCloudFeatures(
      new Set([CONNECTOR_REPLIES_OUTBOX_FEATURE, CONNECTOR_SLACK_PRESENTATION_FEATURE])
    )
    events.useReplyFlush(() => {})
    await events.drainReplies()
    await events.drainReplies()
    expect(reads).toBe(1)
    while (sent.size < 200) {
      const head = events.next(1)
      expect(head).not.toBeNull()
      events.accepted(head!.stamp)
      await events.drainReplies()
    }
    expect(reads).toBe(2)
    expect(events.next(1)?.batch).toMatchObject([{ kind: 'reply', answerDeliveryId: 'd200' }])
  } finally {
    events.clear()
  }
})

it('hands an owed answer to the disclosure check after the event route rolls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reply-rollback-'))
  dirs.push(dir)
  const presentation = SlackAnswerPresentationSchema.parse({
    v: 1,
    text: 'Two tests passed.',
    visual: {
      kind: 'bar',
      title: 'Tests',
      source: 'Build report',
      axis: 'Result',
      unit: 'count',
      labels: ['Passed', 'Failed'],
      series: [{ label: 'Tests', values: [2, 0] }]
    }
  })
  const posted: ConnectorReplyBody[] = []
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async () => [],
      readOwed: async (_account, after, _limit, includePresentations) =>
        after === null
          ? [
              {
                ...row,
                fill: {
                  ...row.fill!,
                  prose: SLACK_PRESENTATION_UNCONFIRMED,
                  turnStartedAt: 8,
                  ...(includePresentations ? { presentation } : {})
                }
              }
            ]
          : [],
      fillOutcomes: async () => false,
      sent: async () => {}
    }),
    onOwed: () => {},
    post: async (body) => {
      posted.push(body)
      return { ok: true, value: {} }
    },
    hostName: () => 'laptop'
  })
  try {
    let revision: number | null = 1
    const requests = new ConnectorEventRequests({
      events,
      watch: () => () => {},
      observe: () => {},
      flush: () => {},
      post: async () => refusal(400, 'invalid_request'),
      rejected: () => {
        revision = null
        return Promise.resolve(null)
      }
    })
    const sender = new ConnectorOutboxSender(
      events,
      (batch, rev, seq) => requests.post(batch, rev, seq),
      () => revision,
      () => 0.5
    )
    events.useCloudFeatures(
      new Set([CONNECTOR_REPLIES_OUTBOX_FEATURE, CONNECTOR_SLACK_PRESENTATION_FEATURE])
    )
    requests.watch()
    await events.drainReplies()
    sender.flush()
    await vi.waitFor(() => expect(revision).toBeNull())
    events.useCloudFeatures(new Set([CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE]))
    events.resetLive()
    requests.watch()
    await events.drainReplies()
    expect(posted).toMatchObject([{ text: slackAnswerText(presentation), presentation, turnId: 8 }])
  } finally {
    events.clear()
  }
})
const h = pollClientHarness()
const typedAnswer = SlackAnswerPresentationSchema.parse({
  v: 1,
  text: 'The count rose.',
  visual: {
    kind: 'bar',
    title: 'Builds',
    source: 'Build report',
    axis: 'Window',
    unit: 'count',
    labels: ['Monday', 'Tuesday'],
    series: [{ label: 'Builds', values: [2, 3] }]
  }
})
const preparedEnd = {
  kind: 'turn-ended',
  conversation: { source: 'slack', externalId: 'T1:C1:1792.9:U5' },
  worktreeId: 'w1',
  paneKey: 'p1',
  turnId: SERVER_NOW - 1_000,
  at: SERVER_NOW,
  stopReason: 'success',
  lastAssistantMessage: slackAnswerText(typedAnswer),
  presentation: typedAnswer
} satisfies ConversationEvent

it('sends the same stamped prepared answer after a persistent parser refusal', async () => {
  h.fake.features = [
    CONNECTOR_SLACK_PRESENTATION_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  h.fake.refusePresentedVersion = true
  const { client, emit } = h.startClient()
  onTestFinished(() => client.stop())
  await settle()
  emit(preparedEnd)
  await settle()
  const recovered = h.fake.requestsTo(CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH).at(-1)
  expect(recovered?.body).toEqual(h.fake.requestsTo(CONNECTOR_PATHS.events).at(-1)?.body)
  expect(h.fake.events.filter((event) => isRecord(event) && event.kind === 'turn-ended')).toEqual([
    expect.objectContaining({
      turnId: preparedEnd.turnId,
      lastAssistantMessage: preparedEnd.lastAssistantMessage,
      presentation: typedAnswer
    })
  ])
})

it('keeps a prepared turn across a receiver downgrade and restart while an unrelated answer goes through', async () => {
  const first = h.startClient()
  onTestFinished(() => first.client.stop())
  await settle()
  first.emit(preparedEnd)
  first.emit({
    ...preparedEnd,
    conversation: { source: 'slack', externalId: 'T1:C2:1792.9:U5' },
    turnId: preparedEnd.turnId + 1,
    presentation: undefined,
    lastAssistantMessage: 'An independent answer.'
  })
  await settle()
  expect(h.fake.events).toContainEqual(
    expect.objectContaining({ lastAssistantMessage: 'An independent answer.' })
  )
  expect(h.fake.events).not.toContainEqual(expect.objectContaining({ turnId: preparedEnd.turnId }))
  first.client.stop()
  await ConnectorTurnEvents.settled()
  h.fake.features = [
    CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  const second = h.startClient()
  onTestFinished(() => second.client.stop())
  await settle()
  expect(
    h.fake.events.filter((event) => isRecord(event) && event.turnId === preparedEnd.turnId)
  ).toEqual([
    expect.objectContaining({
      lastAssistantMessage: preparedEnd.lastAssistantMessage,
      presentation: typedAnswer
    })
  ])
})
