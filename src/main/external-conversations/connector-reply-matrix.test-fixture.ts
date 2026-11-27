import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
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
  holdJournalConnectorRepliesForRetry,
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
import { conversationReplyFill } from './external-conversation-reply-fill'
import { usageLimitReplyPause } from './external-conversation-reply-pause'
import { emptyTurnRetry, type EmptyRetrySend } from './external-conversation-reply-empty-retry'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'

// Phase 1 restart matrix harness, desktop side: a real journal file reopened on every "restart", the real
// admission writer, recovery and fill, a fake clock. Each case asserts the rows' durable outcome.

export const NOW = 1_800_000_000_000
export const LIMIT = { category: 'usage_limit' as const, usageLimit: { resetsAt: NOW + 3_600_000 } }
export const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
export const target = { sessionId: 'chat-1', epoch: 'e' }
export const facts = {
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
/** Each case's own journal directory and fake clock. */
export function installReplyMatrix(): void {
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
}

export function openJournal() {
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
    releaseClaim: async (claim) => releaseJournalConnectorClaim(db, claim) > 0,
    holdForRetry: async (rows) => holdJournalConnectorRepliesForRetry(db, rows) > 0
  }
  return { db, journal }
}

/** The journal writer's admission of one message, in its own transaction. */
export function admit(
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

export const asked = (deliveryId: string, carried?: string[]): AgentJournalMessageItem => ({
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
export function start(
  options: {
    continuationsSettled?: Promise<unknown>
    usageLimitDisposition?: (sessionId: string, turnItemId: string) => Promise<string>
    /** A bot's chat: its quiet marker counts. */
    bot?: boolean
    /** An empty turn's retry: whether the chat tried a post itself, and how its ask's send goes. */
    retry?: { posted?: boolean; send: EmptyRetrySend }
  } = {}
) {
  const { bot = false, retry: retrying, ...recoveryOptions } = options
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
  const retry =
    retrying &&
    emptyTurnRetry({
      journal: () => journal,
      postedSince: () => retrying.posted === true,
      send: retrying.send,
      settled: (sessionId) => recovery.turnEnded(sessionId)
    })
  const fill = conversationReplyFill(
    () => journal,
    () => {},
    usageLimitReplyPause(() => journal, options.usageLimitDisposition ?? (async () => 'ended')),
    undefined,
    retry
  )
  const recovery: ConnectorReplyRecovery = new ConnectorReplyRecovery({
    ...(retry ? { retrySending: retry.sending } : {}),
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
          startedAt: NOW,
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
          ...(row.fill?.failure ? { category: row.fill.failure.category } : {}),
          ...(row.fill?.toolsRan ? { toolsRan: true } : {})
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

export function stampOf(deliveryId: string): AgentJournalConnectorDelivery {
  return { account: 'account-a', conversation: SLACK, deliveryId }
}

export function submissionOf(
  messageId: string,
  fields: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  const fixed = { fence: 1, dispatchState: 'accepted', providerItemId: null, reason: null } as const
  const times = { submittedAt: 1, resolvedAt: 2 }
  return {
    clientMessageId: messageId,
    payloadFingerprint: messageId,
    ...fixed,
    ...times,
    ...fields
  }
}
