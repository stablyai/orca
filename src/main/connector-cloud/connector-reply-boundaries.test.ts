import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { JOURNAL_CONNECTOR_REPLIES_SCHEMA } from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-schema'
import {
  fillJournalConnectorReplies,
  readJournalConnectorReplies,
  recordJournalConnectorReplies,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import Database from '../sqlite/sync-database'
import { eraseRpcMethods, type RpcContext } from '../runtime/rpc/core'
import { CONNECTOR_METHODS } from '../runtime/rpc/methods/connectors/connector'
import { replyTargetOf } from '../external-conversations/external-conversation-types'
import type { ConnectorPollClient } from './connector-poll-client'
import {
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import { drainReplyId, type ConnectorReplyJournal } from './connector-reply-outbox'
import { CONNECTOR_REHELLO_SPREAD_MS } from './connector-poll-control'
import { ConnectorTurnEvents } from './connector-turn-events'
import { postConnectorOutboxReply } from './connector-replies'
import { ConnectorAccountTransport } from './connector-transport'
import { fakeSeam, type FakeSeam } from './fake-connector-seam.test-fixture'
import { harness } from '../external-conversations/external-conversation-seam.test-fixture'
import { WORKTREE } from '../external-conversations/external-conversation.test-fixture'
import { findLink } from '../external-conversations/external-conversation-links'

// Design item 125 §8, desktop boundaries end to end: the journal's own file reopened by a new
// process, and the cloud's wire answering (or losing its answer to) the reply events and posts.

const h = pollClientHarness()
const SLACK = { source: 'slack', externalId: 'T1:C9:1792.9:U5' }

/** One process's handle on the journal file: its outbox table, through the workers' own writes. */
function openJournal(path: string): ConnectorReplyJournal & { db: Database.Database } {
  const db = new Database(path)
  db.exec(JOURNAL_CONNECTOR_REPLIES_SCHEMA)
  return {
    db,
    read: async () => readJournalConnectorReplies(db),
    fillOutcomes: async (fills) => fillJournalConnectorReplies(db, fills, SERVER_NOW) > 0,
    sent: async (keys) => sentJournalConnectorReplies(db, keys, SERVER_NOW)
  }
}

function admitAndAnswer(
  db: Database.Database,
  deliveryId: string,
  prose: string,
  conversation = SLACK
): void {
  recordJournalConnectorReplies(db, { sessionId: 'chat-1', epoch: 'e' }, `m-${deliveryId}`, false, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'review' }],
    connectorDelivery: { account: 'ada', conversation, deliveryId }
  })
  fillJournalConnectorReplies(
    db,
    [{ account: 'ada', deliveryId, outcome: 'answered', answerDeliveryId: deliveryId, prose }],
    SERVER_NOW
  )
}

/** One process: its events outbox over the journal, and a client that posts through the cloud. */
function startProcess(journal: ConnectorReplyJournal, seam?: FakeSeam) {
  let running: ConnectorPollClient | null = null
  const events = new ConnectorTurnEvents(h.userDataPath, 'ada', undefined, {
    journal: () => journal,
    onOwed: () => {},
    // The app's own drain post, over the client's transport.
    post: async (body) =>
      running
        ? postConnectorOutboxReply(
            new ConnectorAccountTransport(h.fake.origin, h.fake.mintFor('ada'), h.fake.fetch),
            body
          )
        : { ok: false, status: 0, error: null, retryAfterMs: null },
    hostName: () => 'box'
  })
  const { client } = h.startClient(seam, events)
  running = client
  return { client, events }
}

const replyEvents = () => h.fake.events.filter((event) => isRecord(event) && event.kind === 'reply')

describe('a reply event whose answer was lost, across a restart', () => {
  it('is sent again by the next process from the reopened journal, then deleted once taken', async () => {
    h.fake.features = ['replies.outbox']
    const file = join(h.userDataPath, 'journal.db')
    const first = openJournal(file)
    const dying = startProcess(first)
    await settle(100)
    // A turn ends: the cloud applies its reply, then the process dies before its answer arrives.
    h.fake.holdAfter.add(CONNECTOR_PATHS.events)
    admitAndAnswer(first.db, 'd1', 'Done.')
    void dying.events.drainReplies()
    await settle(100)
    expect(replyEvents()).toHaveLength(1)
    dying.client.stop()
    first.db.close()
    h.fake.holdAfter.delete(CONNECTOR_PATHS.events)

    const second = openJournal(file)
    expect(readJournalConnectorReplies(second.db)).toHaveLength(1)
    const next = startProcess(second)
    await settle(100)
    const [sent, resent] = replyEvents()
    expect(resent).toEqual(sent)
    expect(readJournalConnectorReplies(second.db)).toEqual([])
    next.client.stop()
    second.db.close()
  })
})

describe('a reply in transit across the kill switch and back', () => {
  it('goes through /replies under the cloud’s kill switch, then as an event again once it lifts', async () => {
    h.fake.features = ['replies.outbox']
    const file = join(h.userDataPath, 'journal.db')
    const first = openJournal(file)
    const dying = startProcess(first)
    await settle(100)
    h.fake.holdAfter.add(CONNECTOR_PATHS.events)
    admitAndAnswer(first.db, 'd1', 'First answer.')
    void dying.events.drainReplies()
    await settle(100)
    dying.client.stop()
    first.db.close()
    h.fake.holdAfter.delete(CONNECTOR_PATHS.events)

    // The cloud flips the kill switch; the restarted desktop's hello no longer lists the outbox.
    h.fake.features = []
    const journal = openJournal(file)
    const next = startProcess(journal)
    await settle(100)
    expect(h.fake.replies.get(drainReplyId('d1'))).toMatchObject({
      text: 'First answer.',
      answerDeliveryId: 'd1'
    })
    expect(readJournalConnectorReplies(journal.db)).toEqual([])

    // The switch flips back: the next hello lists it, and a new answer goes as an event.
    h.fake.features = ['replies.outbox']
    h.fake.forgetHello()
    h.poll([])
    // The 409 asks for a hello after a random spread (0.5 of it here).
    await settle(CONNECTOR_REHELLO_SPREAD_MS)
    admitAndAnswer(journal.db, 'd2', 'Second answer.')
    void next.events.drainReplies()
    await settle(100)
    expect(replyEvents().flatMap((event) => (isRecord(event) ? event.deliveryIds : []))).toEqual([
      'd1',
      'd2'
    ])
    expect(h.fake.replies.size).toBe(1)
    expect(readJournalConnectorReplies(journal.db)).toEqual([])
    next.client.stop()
    journal.db.close()
  })
})

describe('an agent’s own reply through the desktop RPC', () => {
  const reply = eraseRpcMethods(CONNECTOR_METHODS).find((m) => m.name === 'connector.reply')!
  const link: ExternalConversationLink = {
    source: 'slack',
    externalId: SLACK.externalId,
    sessionId: 'chat-1',
    agent: 'claude',
    paneKey: 'pane-1',
    createdAt: 1
  }
  // The running turn's opener carries d1's stamp for this same conversation.
  const opener = {
    itemId: 'opener',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'review' }],
      connectorDelivery: { account: 'ada', conversation: SLACK, deliveryId: 'd1' }
    }
  }

  async function replyUnder(features: string[]): Promise<unknown> {
    h.fake.features = features
    const { client } = h.startClient()
    await settle(100)
    const runtime = {
      getExternalConversationSeam: () => ({
        replyTarget: () => replyTargetOf({ link, workspace: { worktreeId: 'w' } }, 7, opener)
      }),
      getConnectorCloud: () => ({
        cloudFeatures: () => client.cloudFeatures,
        reply: (body: Parameters<ConnectorPollClient['reply']>[0]) => client.reply(body)
      }),
      bots: { enabled: () => false, list: () => [] }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.reply reads only these runtime services.
    const context = { runtime } as unknown as RpcContext
    await reply.handler(
      reply.params!.parse({ paneKey: 'pane-1', replyId: 'r1', text: 'Done.' }),
      context
    )
    client.stop()
    return h.fake.requestsTo(CONNECTOR_PATHS.replies).at(-1)?.body
  }

  it('names its request’s answer key on the wire under a hello that lists the outbox', async () => {
    expect(await replyUnder(['replies.outbox'])).toMatchObject({
      replyId: 'r1',
      answerDeliveryId: 'd1'
    })
  })

  it('leaves the key off under a hello that doesn’t', async () => {
    const body = await replyUnder([])
    expect(body).toMatchObject({ replyId: 'r1' })
    expect(body).not.toHaveProperty('answerDeliveryId')
  })
})

describe('a desktop downgrade and re-upgrade', () => {
  it('leaves an unsent row alone while a build without the outbox runs, then sends that same row', async () => {
    h.fake.features = ['replies.outbox']
    const file = join(h.userDataPath, 'journal.db')
    const journal = openJournal(file)
    admitAndAnswer(journal.db, 'd1', 'Kept answer.')
    // The older build knows no reply outbox: it never reads or sends the journal's rows.
    const legacy = h.startClient(undefined, new ConnectorTurnEvents(h.userDataPath, 'ada'))
    await settle(100)
    legacy.client.stop()
    expect(replyEvents()).toEqual([])
    expect(h.fake.replies.size).toBe(0)
    expect(readJournalConnectorReplies(journal.db)).toMatchObject([
      { deliveryId: 'd1', fill: { prose: 'Kept answer.' } }
    ])

    const upgraded = startProcess(journal)
    await settle(100)
    expect(replyEvents()).toMatchObject([{ deliveryIds: ['d1'], prose: 'Kept answer.' }])
    expect(readJournalConnectorReplies(journal.db)).toEqual([])
    upgraded.client.stop()
    journal.db.close()
  })
})

describe('a Cloud rollback with persisted new-source conversations', () => {
  it('sends Slack snapshots but holds Feishu/Lark replies until compatible Cloud returns', async () => {
    const feishu = { source: 'feishu', externalId: 'app-a:tenant-a:chat-a:root-a' } as const
    const lark = { source: 'lark', externalId: 'app-a:tenant-a:chat-a:root-a' } as const
    const local = harness()
    local.seam.linkChat(feishu, { worktreeId: WORKTREE, sessionId: 'feishu-chat', agent: 'codex' })
    local.seam.linkChat(lark, { worktreeId: WORKTREE, sessionId: 'lark-chat', agent: 'codex' })
    local.seam.linkChat(
      { source: 'slack', externalId: SLACK.externalId },
      {
        worktreeId: WORKTREE,
        sessionId: 'slack-chat',
        agent: 'codex'
      }
    )
    const seam = fakeSeam()
    seam.calls.watch.mockImplementation((_host, listener) => local.seam.watch({}, listener))
    const file = join(h.userDataPath, 'source-rollback.db')
    const first = openJournal(file)
    admitAndAnswer(first.db, 'feishu-d1', 'Feishu answer.', feishu)
    admitAndAnswer(first.db, 'lark-d1', 'Lark answer.', lark)
    h.fake.features = ['feishu.mentions', 'lark.mentions', 'replies.outbox']
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const original = startProcess(first, seam)
    await settle(100)
    original.client.stop()
    first.db.close()

    h.fake.features = []
    h.fake.eventSources = ['slack', 'discord', 'linear', 'github', 'webhook']
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    const journal = openJournal(file)
    const restored = startProcess(journal, seam)
    try {
      await settle(100)
      expect(h.fake.events).toContainEqual({
        kind: 'snapshot',
        conversations: [
          expect.objectContaining({
            conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' }
          })
        ]
      })
      expect(readJournalConnectorReplies(journal.db).map((row) => row.deliveryId)).toEqual([
        'feishu-d1',
        'lark-d1'
      ])
      expect(h.fake.replies.size).toBe(0)
      expect(findLink(local.store, feishu)?.link.sessionId).toBe('feishu-chat')
      expect(findLink(local.store, lark)?.link.sessionId).toBe('lark-chat')
      restored.events.observe({
        kind: 'turn-started',
        conversation: feishu,
        worktreeId: WORKTREE,
        paneKey: 'feishu-pane',
        at: SERVER_NOW
      })
      expect(restored.events.next(2)).toBeNull()
      expect(
        await restored.client.reply({
          replyId: 'manual-feishu',
          conversation: feishu,
          turnId: SERVER_NOW,
          text: 'An explicit reply.'
        })
      ).toMatchObject({ ok: false, error: 'source_unsupported' })
      expect(h.fake.requestsTo(CONNECTOR_PATHS.replies)).toEqual([])

      h.fake.features = ['feishu.mentions', 'lark.mentions', 'replies.outbox']
      h.fake.eventSources = undefined
      h.fake.forgetHello()
      h.poll([])
      await settle(CONNECTOR_REHELLO_SPREAD_MS + 200)
      expect(replyEvents()).toEqual([
        {
          kind: 'reply',
          conversation: feishu,
          deliveryIds: ['feishu-d1'],
          answerDeliveryId: 'feishu-d1',
          outcome: 'answered',
          prose: 'Feishu answer.'
        },
        {
          kind: 'reply',
          conversation: lark,
          deliveryIds: ['lark-d1'],
          answerDeliveryId: 'lark-d1',
          outcome: 'answered',
          prose: 'Lark answer.'
        }
      ])
      expect(readJournalConnectorReplies(journal.db)).toEqual([])
    } finally {
      restored.client.stop()
      local.seam.dispose('connectors_disabled')
      local.db.close()
      journal.db.close()
    }
  })
})
