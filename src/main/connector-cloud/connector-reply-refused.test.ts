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
  slackAnswerText
} from '../../shared/connectors/slack-answer-presentation'
import type { ConnectorReplyBody } from './connector-replies'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorTurnEvents } from './connector-turn-events'
import { ConnectorEventRequests } from './connector-event-requests'
import { ConnectorOutboxSender } from './connector-outbox'
import { connectorPollRetryMs } from './connector-poll-control'
import {
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { fakeSeam } from './fake-connector-seam.test-fixture'
import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/database/journal-domain-migrations'
import {
  fillJournalConnectorReplies,
  recordJournalConnectorReplies,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import { prepareSlackAnswerPresentation } from '../native-chat/agent-session-journal/connector-replies/journal-slack-answer-presentation'

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
  const db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  const turn = { sessionId: row.sessionId, epoch: row.epoch, turnItemId: 'turn-1' }
  db.prepare(`INSERT INTO journal_items
    (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,kind,lifecycle_state,payload_json)
    VALUES(?,?,?,1,1,1,0,0,'turn','running','{}')`).run(turn.sessionId, turn.epoch, turn.turnItemId)
  expect(prepareSlackAnswerPresentation(db, turn, presentation)).toBe(true)
  recordJournalConnectorReplies(db, turn, row.messageId, false, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'What passed?' }],
    connectorDelivery: {
      account: row.account,
      conversation: row.conversation,
      deliveryId: row.deliveryId
    }
  })
  expect(
    fillJournalConnectorReplies(
      db,
      [
        {
          account: row.account,
          deliveryId: row.deliveryId,
          answerDeliveryId: row.deliveryId,
          outcome: 'answered',
          prose: slackAnswerText(presentation),
          turnStartedAt: 8,
          turnItemId: turn.turnItemId,
          presentationTurn: turn
        }
      ],
      10
    )
  ).toBe(1)
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async (sessionId) => readJournalConnectorReplies(db, sessionId),
      readOwed: async (account, after, limit, includePresentations) =>
        readOwedJournalConnectorReplies(db, account, after, limit, includePresentations),
      fillOutcomes: async () => false,
      sent: async (keys) => sentJournalConnectorReplies(db, keys, 11)
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
    expect(posted).toMatchObject([
      {
        replyId: 'outcome-i1NjnxUsj8bvMIAv3kYroL6c8IX3WA3Gnv1y4AKruzU',
        answerDeliveryId: 'd1',
        text: slackAnswerText(presentation),
        presentation,
        turnId: 8
      }
    ])
    expect(readOwedJournalConnectorReplies(db, 'ada', null, 1, true)).toEqual([])
  } finally {
    events.clear()
    db.close()
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

it.each([
  { route: 'events', withdrawn: false },
  { route: 'events', withdrawn: true },
  { route: 'direct', withdrawn: false },
  { route: 'direct', withdrawn: true }
])(
  'parks a prepared $route reply without idle retry after withdrawal=$withdrawn',
  async ({ route, withdrawn }) => {
    const feature = route === 'events' ? [CONNECTOR_REPLIES_OUTBOX_FEATURE] : []
    const capable = [
      CONNECTOR_SLACK_PRESENTATION_FEATURE,
      CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
    ]
    const rows = new Map<string, JournalConnectorReplyRow>()
    const acknowledged: string[] = []
    const direct: ConnectorReplyBody[] = []
    let reads = 0
    let accepting = false
    const events = new ConnectorTurnEvents(h.userDataPath, 'ada', undefined, {
      journal: () => ({
        read: async () => [...rows.values()],
        readOwed: async (_account, after, limit) => {
          reads++
          return [...rows.values()]
            .filter((entry) => after === null || entry.deliveryId > after)
            .slice(0, limit)
        },
        fillOutcomes: async () => false,
        sent: async (keys) =>
          keys.forEach(({ deliveryId }) => {
            acknowledged.push(deliveryId)
            rows.delete(deliveryId)
          })
      }),
      onOwed: () => {},
      post: async (body) => {
        direct.push(body)
        return body.presentation && !accepting
          ? refusal(400, 'invalid_request')
          : { ok: true, value: {} }
      },
      hostName: () => 'laptop'
    })
    h.fake.features = withdrawn ? feature : [...feature, ...capable]
    h.fake.presentedEventStatus = 400
    const { client, emit } = h.startClient(fakeSeam(), events)
    onTestFinished(() => client.stop())
    await settle()
    rows.set(row.deliveryId, {
      ...row,
      fill: {
        ...row.fill!,
        prose: slackAnswerText(typedAnswer),
        presentation: typedAnswer,
        turnStartedAt: 8
      }
    })
    emit(preparedEnd)
    await events.drainReplies()
    await settle()
    // The initial parser refusal may replace its hello before definitively rejecting this batch.
    h.poll([])
    await settle(12_000)
    expect(rows.has('d1')).toBe(true)
    expect(h.fake.events).toContainEqual(
      expect.objectContaining({ turnId: preparedEnd.turnId, stateOnly: true })
    )
    const work = () => ({
      reads,
      direct: direct.length,
      requests: h.fake.requestsTo(CONNECTOR_PATHS.events).length,
      compatibility: h.fake.requestsTo(CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH).length
    })
    const parkedWork = work()
    await settle(10 * 60_000)
    expect(work()).toEqual(parkedWork)

    rows.set('d2', { ...row, deliveryId: 'd2', fill: { ...row.fill!, answerDeliveryId: 'd2' } })
    await events.drainReplies()
    await settle()
    expect(acknowledged).toEqual(['d2'])
    expect(rows.has('d1')).toBe(true)

    accepting = true
    h.fake.presentedEventStatus = undefined
    h.fake.features = [
      ...feature,
      CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
      CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
    ]
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required', reason: 'features' } })
    await settle(32_000)
    expect(acknowledged).toEqual(['d2', 'd1'])
    const recovered = route === 'events' ? h.fake.events : direct.slice(parkedWork.direct)
    expect(recovered.filter((item) => isRecord(item) && item.answerDeliveryId === 'd1')).toEqual([
      expect.objectContaining({ turnId: 8, presentation: typedAnswer })
    ])
    expect(
      h.fake.events.filter(
        (item) => isRecord(item) && item.turnId === preparedEnd.turnId && item.presentation
      )
    ).toHaveLength(1)
  }
)

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
  expect(h.fake.events).toContainEqual(
    expect.objectContaining({ turnId: preparedEnd.turnId, stateOnly: true })
  )
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
    h.fake.events.filter(
      (event) => isRecord(event) && event.turnId === preparedEnd.turnId && !event.stateOnly
    )
  ).toEqual([
    expect.objectContaining({
      lastAssistantMessage: preparedEnd.lastAssistantMessage,
      presentation: typedAnswer
    })
  ])
})

it('drains a real journal page and a later turn and approval while a prepared end is refused', async () => {
  const db = new Database(join(h.userDataPath, 'journal.db'))
  onTestFinished(() => db.close())
  migrateJournalDomainSchema(db)
  const events = new ConnectorTurnEvents(h.userDataPath, 'ada', undefined, {
    journal: () => ({
      read: async (sessionId) => readJournalConnectorReplies(db, sessionId),
      readOwed: async (account, after, limit, includePresentations) =>
        readOwedJournalConnectorReplies(db, account, after, limit, includePresentations),
      fillOutcomes: async () => false,
      sent: async (keys) => sentJournalConnectorReplies(db, keys, SERVER_NOW)
    }),
    onOwed: () => {},
    post: async () => refusal(500, 'unexpected_direct_reply'),
    hostName: () => 'laptop'
  })
  h.fake.features = [
    CONNECTOR_REPLIES_OUTBOX_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  h.fake.presentedEventStatus = 400
  const { client, emit } = h.startClient(fakeSeam(), events)
  onTestFinished(() => client.stop())
  await settle()
  emit(preparedEnd)
  await settle()
  // The refused request dropped the hello while a poll was still waiting under it.
  h.poll([])
  await settle(connectorPollRetryMs(0, refusal(400, 'invalid_request'), () => 0.5))
  expect(h.fake.events).toContainEqual(
    expect.objectContaining({ kind: 'turn-ended', turnId: preparedEnd.turnId, stateOnly: true })
  )
  const nextTurn = preparedEnd.turnId + 1
  emit({
    kind: 'turn-started',
    conversation: preparedEnd.conversation,
    worktreeId: preparedEnd.worktreeId,
    paneKey: preparedEnd.paneKey,
    at: nextTurn
  })
  emit({
    kind: 'prompt',
    conversation: preparedEnd.conversation,
    worktreeId: preparedEnd.worktreeId,
    paneKey: preparedEnd.paneKey,
    prompt: { kind: 'approval', promptId: 'confirm', tool: 'Bash', options: [] }
  })
  const turn = { sessionId: row.sessionId, epoch: row.epoch, turnItemId: 'later-turn' }
  db.prepare(`INSERT INTO journal_items
    (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,kind,lifecycle_state,payload_json)
    VALUES(?,?,?,1,1,1,0,0,'turn','running','{}')`).run(turn.sessionId, turn.epoch, turn.turnItemId)
  const fills = Array.from({ length: 201 }, (_, index) => {
    const deliveryId = `later-${String(index).padStart(3, '0')}`
    recordJournalConnectorReplies(db, turn, deliveryId, false, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Another question' }],
      connectorDelivery: {
        account: row.account,
        conversation: index === 0 ? preparedEnd.conversation : row.conversation,
        deliveryId
      }
    })
    return {
      account: row.account,
      deliveryId,
      answerDeliveryId: deliveryId,
      outcome: 'answered' as const,
      prose: 'An independent answer.',
      turnStartedAt: nextTurn,
      turnItemId: turn.turnItemId
    }
  })
  expect(fillJournalConnectorReplies(db, fills, SERVER_NOW)).toBe(201)
  await events.drainReplies()
  await settle()
  expect(h.fake.events.filter((event) => isRecord(event) && event.kind === 'reply')).toHaveLength(
    201
  )
  expect(readOwedJournalConnectorReplies(db, 'ada', null, 1, true)).toEqual([])
  const threadEvents = h.fake.events.filter(
    (event) =>
      isRecord(event) &&
      isRecord(event.conversation) &&
      event.conversation.externalId === preparedEnd.conversation.externalId &&
      event.kind !== 'reply'
  )
  expect(threadEvents).toEqual([
    expect.objectContaining({ kind: 'turn-ended', turnId: preparedEnd.turnId, stateOnly: true }),
    expect.objectContaining({ kind: 'turn-started', at: nextTurn }),
    expect.objectContaining({
      kind: 'prompt',
      prompt: expect.objectContaining({ promptId: 'confirm' })
    })
  ])
  h.fake.presentedEventStatus = undefined
  h.fake.features = h.fake.features.map((feature) =>
    feature === CONNECTOR_SLACK_PRESENTATION_FEATURE
      ? CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE
      : feature
  )
  client.stop()
  const compatible = h.startClient(fakeSeam(), events)
  onTestFinished(() => compatible.client.stop())
  await settle()
  expect(h.fake.events.filter((event) => isRecord(event) && event.presentation)).toEqual([
    expect.objectContaining({ turnId: preparedEnd.turnId, presentation: typedAnswer })
  ])
})

it('parks a 413 and keeps the prepared answer through live end pressure and restart', async () => {
  h.fake.features = [
    CONNECTOR_SLACK_PRESENTATION_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  h.fake.presentedEventStatus = 413
  const events = new ConnectorTurnEvents(h.userDataPath, 'ada')
  const first = h.startClient(fakeSeam(), events)
  onTestFinished(() => first.client.stop())
  await settle()
  first.emit(preparedEnd)
  await settle()
  const compatibleRequests = () => h.fake.requestsTo(CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH)
  expect(compatibleRequests()).toHaveLength(1)
  await settle(61_000)
  expect(compatibleRequests()).toHaveLength(1)
  first.client.stop()
  // Accumulate the pressure without transport receipts consuming the ordinary queue.
  for (let index = 1; index <= 201; index++) {
    events.observe({
      ...preparedEnd,
      turnId: preparedEnd.turnId + index,
      presentation: undefined,
      lastAssistantMessage: 'Ordinary words.'
    })
  }
  await ConnectorTurnEvents.settled()
  const restarted = new ConnectorTurnEvents(h.userDataPath, 'ada')
  const release = Array.from({ length: 199 }, (_, index) =>
    restarted.reservePrepared(`reserved-${index}`)
  )
  expect(release.every(Boolean)).toBe(true)
  expect(restarted.reservePrepared('overflow')).toBeNull()
  release.forEach((free) => free?.())
  h.fake.presentedEventStatus = undefined
  h.fake.features = [
    CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
  ]
  const second = h.startClient(fakeSeam(), restarted)
  onTestFinished(() => second.client.stop())
  await settle()
  expect(h.fake.events.filter((event) => isRecord(event) && event.presentation)).toEqual([
    expect.objectContaining({
      turnId: preparedEnd.turnId,
      conversation: preparedEnd.conversation,
      lastAssistantMessage: slackAnswerText(typedAnswer),
      presentation: typedAnswer
    })
  ])
})
