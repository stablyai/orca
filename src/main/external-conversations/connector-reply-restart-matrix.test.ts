import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  readJournalConnectorReplies,
  recutJournalConnectorReplies,
  releaseJournalConnectorClaim,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import { readJournalDomainDispatchItem } from '../native-chat/agent-session-journal/journal-domain-dispatch-placement'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import Database from '../sqlite/sync-database'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import { conversationReplyFill } from './external-conversation-reply-fill'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'

// Phase 1 restart matrix, desktop side: a real journal file reopened on every "restart", the real
// admission writer, recovery and fill, a fake clock. Each case asserts the rows' durable outcome.

const NOW = 1_800_000_000_000
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
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-matrix-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function openJournal() {
  const db = new Database(join(dir, 'journal.db'))
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
    fillOutcomes: async (fills) => fillJournalConnectorReplies(db, fills, NOW) > 0,
    sent: async (keys) => sentJournalConnectorReplies(db, keys, NOW),
    cut: async (rows) => cutJournalConnectorReplies(db, rows) > 0,
    recut: async (claim, cut) => recutJournalConnectorReplies(db, claim, cut) > 0,
    releaseClaim: async (claim) => releaseJournalConnectorClaim(db, claim) > 0
  }
  return { db, journal }
}

/** The journal writer's admission of one message, in its own transaction. */
function admit(db: Database.Database, messageId: string, body: AgentJournalMessageItem): void {
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
        }
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

/** One process: the journal reopened, its recovery over the items the test says the chat holds. */
function start(options: { continuationsSettled?: Promise<unknown> } = {}) {
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
    () => {}
  )
  const recovery = new ConnectorReplyRecovery({
    journal: () => journal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery calls only these chat members.
    chat: () => chat as never,
    hasSession: () => true,
    isBot: () => false,
    agentOf: () => 'claude',
    fillTurn: fill,
    filled: () => {},
    ...options
  })
  const message = (messageId: string) =>
    readJournalDomainDispatchItem(db, target, agentJournalSubmissionKey(messageId))!.item
  // A provider turn the message opened, with what it said, as the journal shows it.
  const turn = (
    key: string,
    openerId: string,
    state: AgentJournalTurnLifecycleState,
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
          state,
          ...(state === 'completed' ? { outcome: 'success' as const } : {}),
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
  return { db, journal, recovery, message, turn, show, outcomes, publish, items: () => items }
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

describe('no positional "answered together"', () => {
  it('tells an unconfirmed end for a delivered send no turn proves it took, never unattributed', async () => {
    const p = start({ continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    admit(p.db, 'other', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'unrelated' }]
    })
    p.show([p.message('m1'), ...p.turn('item:t1', 'other', 'completed', 'Unrelated answer.')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1', category: 'unconfirmed' }
    })
  })
})

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
