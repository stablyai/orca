import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  CONNECTOR_PATHS,
  ConnectorConversation
} from '../../shared/connectors/connector-cloud-contract'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import {
  fillJournalConnectorReplies,
  readJournalConnectorReplies,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import { readJournalDomainDispatchItem } from '../native-chat/agent-session-journal/journal-domain-dispatch-placement'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { conversationReplyFill } from '../external-conversations/external-conversation-reply-fill'
import {
  ConnectorReplyRecovery,
  type ReplyRecoveryChat
} from '../external-conversations/external-conversation-reply-recovery'
import Database from '../sqlite/sync-database'
import type { ConnectorPollClient } from './connector-poll-client'
import {
  base,
  isRecord,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import type { ConnectorReplyJournal } from './connector-reply-outbox'
import { ConnectorTurnEvents } from './connector-turn-events'
import { fakeSeam } from './fake-connector-seam.test-fixture'

// Design item 125 §8, a committed admission across a crash before its first acknowledgement: the
// journal's own admission writes the head's and carried send's rows, a new process reopens the file,
// acknowledges both when the cloud hands them out again, and recovery answers both from the journal.

const h = pollClientHarness()
const target = { sessionId: 'chat-1', epoch: 'e' }
const facts = {
  identity: {
    sessionId: 'chat-1',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'claude' as const,
    providerHandle: null
  }
}

function openJournal(file: string) {
  const db = new Database(file)
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT OR IGNORE INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
  const journal: ConnectorReplyJournal = {
    read: async (sessionId) =>
      readJournalConnectorReplies(db).filter(
        (row) => sessionId === undefined || row.sessionId === sessionId
      ),
    fillOutcomes: async (fills) => fillJournalConnectorReplies(db, fills, SERVER_NOW) > 0,
    sent: async (keys) => sentJournalConnectorReplies(db, keys, SERVER_NOW)
  }
  return { db, journal }
}

/** The journal writer's admission of one stamped message, in its own transaction. */
function admit(db: Database.Database, messageId: string, body: AgentJournalMessageItem): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    applyJournalDomainSubmission(
      db,
      h.userDataPath,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: messageId,
          body,
          payloadFingerprint: agentSessionSendBodyFingerprint('chat-1', body),
          fence: 1,
          handoverRecorded: true,
          origin: 'client',
          source: { kind: 'user' }
        }
      },
      facts,
      SERVER_NOW
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const asker = {
  userId: 'U0DANA',
  role: 'owner',
  place: { kind: 'channel', id: 'C0FEED' },
  context: []
}
const handout = () =>
  [
    {
      ...base,
      deliveryId: 'd1',
      kind: 'start',
      agent: 'claude',
      placeId: Buffer.from(JSON.stringify(['bot', 'b1'])).toString('base64url'),
      prompt: 'fix it'
    },
    { ...base, deliveryId: 'd2', kind: 'send', text: 'and the tests' }
  ].map((delivery) => ({
    ...delivery,
    asker: { ...asker, text: 'fix it' },
    askedAt: base.expiresAt - 400_000
  }))

const acked = () =>
  h.fake.acks.map((ack) => (isRecord(ack) ? `${String(ack.deliveryId)}:${String(ack.step)}` : ''))

describe('a committed head and its carried send, across a crash before their first ack', () => {
  it('keeps both in the reopened journal, acknowledges both, and answers both', async () => {
    h.fake.features = ['replies.outbox']
    const file = join(h.userDataPath, 'journal.db')
    const first = openJournal(file)
    const seam = fakeSeam()
    // The seam's start admits through the journal writer, stamped with the head and its carried send.
    seam.calls.start.mockImplementation(
      async (_host: unknown, key: unknown, id: string, ...rest: unknown[]) => {
        const [options] = rest
        const reply = isRecord(options) && isRecord(options.reply) ? options.reply : {}
        admit(first.db, `m-${id}`, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'fix it' }],
          connectorDelivery: {
            account: String(reply.account),
            conversation: ConnectorConversation.parse(key),
            deliveryId: id,
            carried: Array.isArray(reply.carried) ? reply.carried.map(String) : []
          }
        })
        return { conversation: key, initial: { outcome: 'accepted' as const } }
      }
    )
    h.fake.holdBefore.add(CONNECTOR_PATHS.acks)
    const dying = h.startClient(seam)
    await settle()
    h.poll(handout())
    await settle()
    dying.client.stop()
    first.db.close()
    expect(h.fake.acks).toEqual([])

    // The next process: custody of both requests is the reopened journal's.
    const { db, journal } = openJournal(file)
    const rows = readJournalConnectorReplies(db)
    expect(rows.map((row) => [row.deliveryId, row.messageId, row.fill ?? null]).sort()).toEqual([
      ['d1', 'm-d1', null],
      ['d2', 'm-d1', null]
    ])
    const restarted = fakeSeam()
    for (const row of rows) {
      restarted.recorded.set(row.deliveryId, { outcome: 'accepted' })
    }
    h.fake.holdBefore.delete(CONNECTOR_PATHS.acks)
    let running: ConnectorPollClient | null = null
    const events = new ConnectorTurnEvents(h.userDataPath, 'ada', undefined, {
      journal: () => journal,
      onOwed: () => {},
      post: async (body) =>
        running?.reply(body) ?? { ok: false, status: 0, error: null, retryAfterMs: null },
      hostName: () => 'box'
    })
    const next = h.startClient(restarted, events)
    running = next.client
    await settle()
    h.poll(handout())
    await settle(2_000)
    expect(acked().sort()).toEqual(['d1:done', 'd1:received', 'd2:done', 'd2:received'])

    // The turn the head opened ends while nothing listened: recovery answers both from the journal.
    const opener = readJournalDomainDispatchItem(
      db,
      target,
      agentJournalSubmissionKey('m-d1')
    )!.item
    const turnKey = 'item:turn-1'
    const items: AgentJournalRenderItem[] = [
      opener,
      {
        itemId: 'said',
        revision: 1,
        sequence: opener.sequence + 1,
        observedAt: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed.' }] },
        turnScope: { kind: 'turn', turnItemId: turnKey }
      },
      {
        itemId: turnKey,
        revision: 1,
        sequence: opener.sequence + 2,
        observedAt: 1,
        body: {
          kind: 'turn',
          turnId: 'provider-turn',
          state: 'completed',
          outcome: 'success',
          userItemId: opener.itemId
        }
      }
    ]
    const chat: ReplyRecoveryChat = {
      conversation: async () => ({}),
      journalReads: async () => ({
        operationWindow: async () => ({
          snapshot: {
            sessionId: 'chat-1',
            cursor: { epoch: 'e', sequence: 99 },
            items,
            submissions: []
          },
          complete: true
        }),
        canonicalItemIds: async (ids: readonly string[]) =>
          ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
      }),
      observeJournalPublications: () => () => {}
    }
    const recovery = new ConnectorReplyRecovery({
      journal: () => journal,
      chat: () => chat,
      hasSession: () => true,
      isBot: () => false,
      agentOf: () => 'claude',
      fillTurn: conversationReplyFill(
        () => journal,
        () => void events.drainReplies()
      ),
      filled: () => void events.drainReplies()
    })
    await recovery.boot()
    await settle(100)
    const sent = h.fake.events.filter((event) => isRecord(event) && event.kind === 'reply')
    expect(sent.flatMap((event) => (isRecord(event) ? event.deliveryIds : [])).sort()).toEqual([
      'd1',
      'd2'
    ])
    expect(readJournalConnectorReplies(db)).toEqual([])
    next.client.stop()
    db.close()
  })
})
