import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalConnectorClaim,
  AgentJournalConnectorDelivery
} from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycleState
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import {
  cutJournalConnectorReplies,
  fillJournalConnectorReplies,
  recutJournalConnectorReplies,
  releaseJournalConnectorClaim,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import { readJournalDomainDispatchItem } from '../native-chat/agent-session-journal/journal-domain-dispatch-placement'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import Database from '../sqlite/sync-database'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import { conversationReplyFill, journalAskedByOwner } from './external-conversation-reply-fill'
import { readJournalDomainSubmissionBody } from '../native-chat/agent-session-journal/journal-domain-submission-records'
import { applyJournalDomainQueueCommand } from '../native-chat/agent-session-journal/journal-domain-queue-command'
import { usageLimitReplyPause } from './external-conversation-reply-pause'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { replyEventsOf } from '../connector-cloud/connector-reply-outbox'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'

// Phase 1 restart matrix, desktop side: a real journal file reopened on every "restart", the real
// admission writer, recovery and fill, a fake clock. Each case asserts the rows' durable outcome.

const NOW = 1_800_000_000_000
const LIMIT = { category: 'usage_limit' as const, usageLimit: { resetsAt: NOW + 3_600_000 } }
const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
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

let dir = ''
// Windows refuses to delete a directory whose SQLite file a connection still holds.
const openedDatabases: Database[] = []
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-matrix-'))
})
afterEach(() => {
  vi.useRealTimers()
  for (const db of openedDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed by the case itself.
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

function openJournal() {
  const db = new Database(join(dir, 'journal.db'))
  openedDatabases.push(db)
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT OR IGNORE INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
  const journal: ConnectorReplyCutJournal = {
    read: async (sessionId) =>
      readJournalConnectorReplies(db).filter(
        (row) => sessionId === undefined || row.sessionId === sessionId
      ),
    readOwed: async (account, after, limit) =>
      readOwedJournalConnectorReplies(db, account, after, limit),
    fillOutcomes: async (fills) => fillJournalConnectorReplies(db, fills, NOW) > 0,
    sent: async (keys) => sentJournalConnectorReplies(db, keys, NOW),
    cut: async (rows) => cutJournalConnectorReplies(db, rows) > 0,
    recut: async (claim, cut, failure) => recutJournalConnectorReplies(db, claim, cut, failure) > 0,
    releaseClaim: async (claim) => releaseJournalConnectorClaim(db, claim) > 0
  }
  return { db, journal }
}

/** The journal writer's admission of one message, in its own transaction. */
function admit(
  db: Database.Database,
  messageId: string,
  body: AgentJournalMessageItem,
  /** The queued card this send hands over, as a busy chat's delivery is sent. */
  card?: string
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    applyJournalDomainSubmission(
      db,
      dir,
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
        },
        ...(card ? { consume: { messageId: card, expect: 'waiting' as const } } : {})
      },
      facts,
      NOW
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const asked = (deliveryId: string, carried?: string[]): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix it' }],
  connectorDelivery: {
    account: 'account-a',
    conversation: SLACK,
    deliveryId,
    ...(carried ? { carried } : {})
  }
})

/** A delivery to a busy chat: queued as a card (its outbox row keeps the card's id). */
function queue(db: Database.Database, cardId: string, body: AgentJournalMessageItem): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    applyJournalDomainQueueCommand(
      db,
      dir,
      target,
      { kind: 'queue-insert', input: { messageId: cardId, body } },
      NOW
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** One process: the journal reopened, its recovery over the items the test says the chat holds. */
function start(
  options: {
    continuationsSettled?: Promise<unknown>
    usageLimitDisposition?: (sessionId: string, turnItemId: string) => Promise<string>
    /** A bot's chat: its quiet marker counts. */
    bot?: boolean
  } = {}
) {
  const { bot = false, ...recoveryOptions } = options
  const { db, journal } = openJournal()
  let items: AgentJournalRenderItem[] = []
  let submissions: AgentJournalSubmission[] = []
  const observers: (() => void)[] = []
  const chat = {
    conversation: async () => ({}),
    journalReads: async () => ({
      operationWindow: async () => ({
        snapshot: { sessionId: 'chat-1', cursor: { epoch: 'e', sequence: 99 }, items, submissions },
        complete: true
      }),
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    }),
    observeJournalPublications: (_sessionId: string, observer: () => void) => {
      observers.push(observer)
      return () => observers.splice(observers.indexOf(observer), 1)
    }
  }
  const fill = conversationReplyFill(
    () => journal,
    () => {},
    usageLimitReplyPause(() => journal, options.usageLimitDisposition ?? (async () => 'ended')),
    // The production adapter over the journal's own submission-body read.
    journalAskedByOwner(async () => ({
      submissionBody: async (messageId, read) =>
        readJournalDomainSubmissionBody(db, target, messageId, read?.family)
    }))
  )
  const recovery = new ConnectorReplyRecovery({
    journal: () => journal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
    chat: () => chat as never,
    hasSession: () => true,
    isBot: () => bot,
    agentOf: () => 'claude',
    fillTurn: fill,
    filled: () => {},
    ...recoveryOptions
  })
  const message = (messageId: string) =>
    readJournalDomainDispatchItem(db, target, agentJournalSubmissionKey(messageId))!.item
  // A provider turn the message opened, with what it said, as the journal shows it.
  const turn = (
    key: string,
    openerId: string,
    // `failed`: completed with a failure, as a usage limit ends a turn.
    ended: AgentJournalTurnLifecycleState | 'failed',
    prose?: string
  ): AgentJournalRenderItem[] => {
    const opener = message(openerId)
    const at = Math.max(opener.sequence, ...items.map((item) => item.sequence)) + 1
    return [
      ...(prose
        ? [
            {
              itemId: `said-${key}`,
              revision: 1,
              sequence: at,
              observedAt: at,
              body: {
                kind: 'message' as const,
                role: 'assistant' as const,
                blocks: [{ type: 'text' as const, text: prose }]
              },
              turnScope: { kind: 'turn' as const, turnItemId: key }
            }
          ]
        : []),
      {
        itemId: key,
        revision: 1,
        sequence: at + 1,
        observedAt: at + 1,
        body: {
          kind: 'turn',
          turnId: `provider-${key}`,
          state: ended === 'failed' ? ('completed' as const) : ended,
          ...(ended === 'completed' ? { outcome: 'success' as const } : {}),
          ...(ended === 'failed' ? { outcome: 'failure' as const } : {}),
          userItemId: opener.itemId
        }
      }
    ]
  }
  const show = (next: AgentJournalRenderItem[], nextSubmissions: AgentJournalSubmission[] = []) => {
    items = next
    submissions = nextSubmissions
  }
  const outcomes = () =>
    Object.fromEntries(
      readJournalConnectorReplies(db).map((row) => [
        row.deliveryId,
        {
          outcome: row.fill?.outcome ?? null,
          ...(row.fill?.prose ? { prose: row.fill.prose } : {}),
          ...(row.fill?.answerDeliveryId ? { head: row.fill.answerDeliveryId } : {}),
          ...(row.fill?.failure ? { category: row.fill.failure.category } : {})
        }
      ])
    )
  const publish = async () => {
    observers.forEach((observer) => observer())
    await vi.advanceTimersByTimeAsync(2_000)
  }
  // A live end of a turn the usage limit stopped, as the turn-end watch fills it.
  const limited = (turnItemId: string, openerId: string, stamps: AgentJournalConnectorDelivery[]) =>
    fill({
      sessionId: 'chat-1',
      turnItemId,
      stamps,
      openerItemId: agentJournalSubmissionKey(openerId),
      outcome: 'failure',
      prose: '',
      bot: false,
      links: [],
      failure: LIMIT
    })
  return {
    db,
    journal,
    recovery,
    message,
    turn,
    show,
    outcomes,
    publish,
    limited,
    fillTurn: fill,
    items: () => items
  }
}

describe('a restart cut, continued at launch', () => {
  it('answers the cut request and its carried send under the original head with the continuation’s words', async () => {
    const launch = Promise.withResolvers<void>()
    const before = start()
    admit(before.db, 'm1', asked('d1', ['d2']))
    before.db.close()
    // Restart: the turn m1 opened was cut; this launch continues it.
    const p = start({ continuationsSettled: launch.promise })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null }, d2: { outcome: null } })
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1', 'd2'])
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', 'All fixed.')])
    launch.resolve()
    await p.publish()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'All fixed.', head: 'd1' },
      d2: { outcome: 'answered', prose: 'All fixed.', head: 'd1' }
    })
  })

  it('claims a request whose send was cut before its turn was seen (a send’s cut)', async () => {
    const launch = Promise.withResolvers<void>()
    const p = start({ continuationsSettled: launch.promise })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1')], [submissionOf('m1', { dispatchState: 'unknown' })])
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'm1', kind: 'restart' })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show([
      ...p.items(),
      p.message('c1'),
      ...p.turn('item:t2', 'c1', 'completed', 'Done after the restart.')
    ])
    launch.resolve()
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Done after the restart.', head: 'd1' }
    })
  })

  it('leaves a cut owed until this launch settled, then closes what nothing continued as interrupted', async () => {
    const launch = Promise.withResolvers<void>()
    const p = start({ continuationsSettled: launch.promise })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    // A crash cut this launch adopts later reads "no offer" now: nothing closes before it settles.
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    launch.resolve()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'interrupted', head: 'd1' } })
  })

  it('never lets the cut turn’s own late end fill a row its continuation claimed', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    const fill = conversationReplyFill(
      () => p.journal,
      () => {}
    )
    await fill({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: claim!.origin,
      openerItemId: agentJournalSubmissionKey('m1'),
      outcome: 'success',
      prose: 'Stale words.',
      bot: false,
      links: []
    })
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
  })

  it('tells an unconfirmed end when the claiming continuation never became a turn', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: claim!
    })
    p.show(
      [...p.items(), p.message('c1')],
      [submissionOf('c1', { dispatchState: 'unknown', recovered: true })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1', category: 'unconfirmed' }
    })
  })

  it('answers through a second continuation after the first one’s turn was cut too', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const first = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: first!
    })
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'interrupted')])
    const second = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t2',
      kind: 'restart'
    })
    expect(second?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c2', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: second!
    })
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t3', 'c2', 'completed', 'Finally.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Finally.', head: 'd1' } })
  })

  it('answers through a second continuation when a restart cut the first before its turn opened', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const first = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: first!
    })
    // The next launch's marker names the continuation's own send: no turn took it.
    p.show([...p.items(), p.message('c1')], [submissionOf('c1', { dispatchState: 'pending' })])
    const second = await p.recovery.claimFor('chat-1', { turnId: 'c1', kind: 'restart' })
    expect(second?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c2', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue.' }],
      connectorClaim: second!
    })
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t2', 'c2', 'completed', 'Picked up.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Picked up.', head: 'd1' } })
  })
})

describe('a usage-limit pause', () => {
  const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: claim
  })

  it('pauses the request while its continue is pending, and the continue answers it', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    const ended = await p.limited('item:t1', 'm1', [stampOf('d1')])
    expect(ended.paused).toBe(true)
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    expect(claim?.origin.map((stamp) => stamp.deliveryId)).toEqual(['d1'])
    admit(p.db, 'c1', continueBody(claim!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', 'Back on it.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Back on it.', head: 'd1' } })
  })

  it('fails the request with the limit it hit once no continue will come', async () => {
    let disposition = 'pending'
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => disposition
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.limited('item:t1', 'm1', [stampOf('d1')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
    // The person cancelled the automatic continue: no journal change, only the chat's status.
    disposition = 'ended'
    p.recovery.statusChanged('chat-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })

  it('fails the request when the continue’s send went unconfirmed and it never claimed (U4)', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'ambiguous'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.journal.cut({
      keys: [{ account: 'account-a', deliveryId: 'd1' }],
      cut: { turnId: 'item:t1', kind: 'usage_limit' },
      failure: LIMIT
    })
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'failed', head: 'd1', category: 'usage_limit' }
    })
  })

  it('cuts a restart continuation’s claim again when its own turn hits the limit (A12)', async () => {
    const p = start({
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const restart = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', continueBody(restart!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'failed')])
    await p.limited('item:t2', 'c1', restart!.origin)
    const resume = await p.recovery.claimFor('chat-1', { turnId: 'item:t2', kind: 'usage_limit' })
    expect(resume).toMatchObject({ cutKind: 'usage_limit', origin: [{ deliveryId: 'd1' }] })
    admit(p.db, 'c2', continueBody(resume!))
    p.show([...p.items(), p.message('c2'), ...p.turn('item:t3', 'c2', 'completed', 'Resumed.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Resumed.', head: 'd1' } })
  })
})

describe('a bot’s answer to its owner’s DM across a pause or a restart', () => {
  const DM = { source: 'slack', externalId: 'T1:D0OWNER:D0OWNER:U9' }
  const dmAsked = (deliveryId: string, role: 'owner' | 'member'): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'fix it' }],
    origin: 'connector',
    asker: {
      source: 'slack',
      userId: role === 'owner' ? 'U0OWNER' : 'U0MEMBER',
      role,
      place: { kind: 'direct_message', id: 'D0OWNER' }
    },
    connectorDelivery: { account: 'account-a', conversation: DM, deliveryId }
  })
  const continued = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue.' }],
    connectorClaim: claim
  })
  // The DM asks, the usage limit pauses it, and the automatic continue answers with `prose`.
  const pausedThenContinued = async (role: 'owner' | 'member', prose: string) => {
    const p = start({
      bot: true,
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', dmAsked('d1', role))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    const stamp = { account: 'account-a', conversation: DM, deliveryId: 'd1' }
    expect((await p.limited('item:t1', 'm1', [stamp])).paused).toBe(true)
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    admit(p.db, 'c1', continued(claim!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'completed', prose)])
    await p.recovery.boot()
    return p.outcomes()
  }

  it('posts the words the continue wrote before its marker, once, when the owner asked', async () => {
    expect(await pausedThenContinued('owner', 'Both fixes landed.\n\nNO_REPLY')).toEqual({
      d1: { outcome: 'answered', prose: 'Both fixes landed.', head: 'd1' }
    })
  })

  it('keeps a continue that wrote only the marker quiet', async () => {
    expect(await pausedThenContinued('owner', 'NO_REPLY')).toEqual({
      d1: { outcome: 'quiet', head: 'd1' }
    })
  })

  it('keeps a member’s DM quiet through the pause, as before', async () => {
    expect(await pausedThenContinued('member', 'Owner-only note.\n\nNO_REPLY')).toEqual({
      d1: { outcome: 'quiet', head: 'd1' }
    })
  })

  // The DM arrives while the bot is busy: a card, handed over later as its own send.
  const queuedThenPaused = async (role: 'owner' | 'member') => {
    const p = start({
      bot: true,
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    queue(p.db, 'q1', dmAsked('d1', role))
    admit(p.db, 's1', dmAsked('d1', role), 'q1')
    p.show([p.message('s1'), ...p.turn('item:t1', 's1', 'failed')])
    const stamp = { account: 'account-a', conversation: DM, deliveryId: 'd1' }
    expect((await p.limited('item:t1', 's1', [stamp])).paused).toBe(true)
    const claim = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    admit(p.db, 'c1', continued(claim!))
    p.show([
      ...p.items(),
      p.message('c1'),
      ...p.turn('item:t2', 'c1', 'completed', 'Both fixes landed.\n\nNO_REPLY')
    ])
    await p.recovery.boot()
    return p.outcomes()
  }

  it('posts the words for a DM the owner sent while the bot was busy (a queued card)', async () => {
    expect(await queuedThenPaused('owner')).toEqual({
      d1: { outcome: 'answered', prose: 'Both fixes landed.', head: 'd1' }
    })
  })

  it('keeps a member’s queued DM quiet', async () => {
    expect(await queuedThenPaused('member')).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
  })

  it('posts the owner’s answer from a restart continuation after the journal reopened', async () => {
    const launch = Promise.withResolvers<void>()
    const before = start({ bot: true })
    admit(before.db, 'm1', dmAsked('d1', 'owner'))
    before.db.close()
    const p = start({ bot: true, continuationsSettled: launch.promise })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    const claim = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    })
    admit(p.db, 'c1', continued(claim!))
    p.show([
      ...p.items(),
      p.message('c1'),
      ...p.turn('item:t2', 'c1', 'completed', 'Picked it back up.\n\nNO_REPLY')
    ])
    launch.resolve()
    await p.publish()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'answered', prose: 'Picked it back up.', head: 'd1' }
    })
  })
})

describe('no positional "answered together" across a restart', () => {
  const unrelated: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'unrelated' }]
  }

  it('tells an unconfirmed end for a send an earlier process accepted that no turn proves it took', async () => {
    vi.setSystemTime(NOW)
    const before = start()
    admit(before.db, 'm1', asked('d1'))
    before.db.close()
    vi.setSystemTime(NOW + 60_000)
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'other', unrelated)
    p.show(
      [p.message('m1'), ...p.turn('item:t1', 'other', 'completed', 'Unrelated answer.')],
      [submissionOf('m1', { submittedAt: NOW })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1', category: 'unconfirmed' }
    })
  })

  it('answers together a follow-up sent into a running turn once a later turn ends', async () => {
    vi.setSystemTime(NOW - 60_000)
    const p = start()
    admit(p.db, 'm0', asked('d0'))
    admit(p.db, 'm1', asked('d1'))
    p.recovery.admitted('chat-1')
    const first = [p.message('m0'), ...p.turn('item:t1', 'm0', 'completed', 'First answer.')]
    const sends = [
      submissionOf('m0', { submittedAt: NOW }),
      submissionOf('m1', { submittedAt: NOW })
    ]
    p.show([...first, p.message('m1')], sends)
    p.recovery.turnEnded('chat-1')
    await p.publish()
    // Orchestration mail wakes a later turn after the follow-up, and it ends.
    admit(p.db, 'mail', unrelated)
    p.show(
      [...p.items(), p.message('mail'), ...p.turn('item:t2', 'mail', 'completed', 'Mail.')],
      [...sends, submissionOf('mail', { submittedAt: NOW })]
    )
    p.recovery.turnEnded('chat-1')
    await p.publish()
    expect(p.outcomes().d1).toEqual({ outcome: 'unattributed', head: 'd1' })
  })

  it('leaves a send still queued for handover owed when an unrelated turn ends', async () => {
    vi.setSystemTime(NOW - 60_000)
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    admit(p.db, 'other', unrelated)
    p.show(
      [p.message('m1'), ...p.turn('item:t1', 'other', 'completed', 'Unrelated answer.')],
      [submissionOf('m1', { dispatchState: 'pending', submittedAt: NOW, handoverRecorded: true })]
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: null } })
  })
})

describe('a send rejected before it ran', () => {
  it('reads a Stop or close that took the send back as stopped, and any other rejection as failed', async () => {
    const p = start()
    const kinds = { d1: 'cancelled', d2: 'chatClosed', d3: 'notSignedIn' } as const
    for (const id of Object.keys(kinds)) {
      admit(p.db, id, asked(id))
    }
    p.show(
      Object.keys(kinds).map((id) => p.message(id)),
      Object.entries(kinds).map(([id, kind]) =>
        submissionOf(id, { dispatchState: 'rejected', rejection: agentSessionFailureFact(kind) })
      )
    )
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'withdrawn', head: 'd1' },
      d2: { outcome: 'withdrawn', head: 'd2' },
      d3: { outcome: 'failed', head: 'd3', category: 'signed_out' }
    })
  })
})

describe('the reply names the turn that answered it', () => {
  const TURN_AT = NOW - 30_000
  const owedEvents = async (journal: ConnectorReplyCutJournal) =>
    replyEventsOf(
      (await journal.readOwed('account-a', '', 50)).flatMap((row) =>
        row.fill ? [{ ...row, fill: row.fill }] : []
      )
    )

  it('a send steered into a turn goes out with the turn its live end knew', async () => {
    const p = start()
    admit(p.db, 'm1', asked('d1'))
    admit(p.db, 'm2', asked('d2'))
    const submissions = [
      submissionOf('m1', { answeredInTurn: { turnItemId: 'item:t1', via: 'start' } }),
      submissionOf('m2', { answeredInTurn: { turnItemId: 'item:t1', via: 'steer' } })
    ]
    const items = [p.message('m1'), p.message('m2'), ...p.turn('item:t1', 'm1', 'completed')]
    const opener = p.message('m1')
    await p.fillTurn({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: connectorReplyTurnStamps({ items, submissions }, opener, 'item:t1'),
      openerItemId: opener.itemId,
      outcome: 'success',
      prose: 'Both.',
      bot: false,
      links: [],
      turnStartedAt: TURN_AT
    })
    // Read back after a reopen: the turn is the row's, not the live process's.
    p.db.close()
    const after = start()
    expect(await owedEvents(after.journal)).toEqual([
      expect.objectContaining({ deliveryIds: ['d1', 'd2'], outcome: 'answered', turnId: TURN_AT })
    ])
  })

  it('a turn recovery filled at boot names none, so the cloud keeps its own reading', async () => {
    const before = start()
    admit(before.db, 'm1', asked('d1'))
    before.db.close()
    const p = start({ continuationsSettled: Promise.resolve() })
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed', 'Done.')])
    await p.recovery.boot()
    const [event] = await owedEvents(p.journal)
    expect(event).toMatchObject({ deliveryIds: ['d1'], outcome: 'answered' })
    expect(event).not.toHaveProperty('turnId')
  })
})

function stampOf(deliveryId: string): AgentJournalConnectorDelivery {
  return { account: 'account-a', conversation: SLACK, deliveryId }
}

function submissionOf(
  messageId: string,
  fields: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: messageId,
    fence: 1,
    payloadFingerprint: messageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...fields
  }
}
