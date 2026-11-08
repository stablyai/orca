import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainEditLease } from './journal-domain-edit-leases'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { journalMailSenderKey } from './journal-writer-host-facts'
import { JournalSqlScope } from './journal-sql-scope'
import {
  readJournalSqlQueue,
  type JournalSqlQueueFacts,
  type JournalSqlQueueRead
} from './journal-sql-queued-messages'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

type QueueRead = JournalSqlQueueRead extends infer R
  ? R extends unknown
    ? Omit<R, 'facts'>
    : never
  : never
const target = { sessionId: 'chat', epoch: 'epoch' }
const cleanups: (() => void)[] = []
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const from = {
  kind: 'agent' as const,
  senders: [],
  orchestration: {
    message: 'mail-notice' as const,
    mailbox: 'owner',
    dispatchId: null,
    messages: []
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function fixture() {
  const db = new Database(':memory:')
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-queue-reader-'))
  cleanups.push(() => {
    db.close()
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
    VALUES('workspace','chat','epoch',10,1)`).run()
  const transaction = <T>(write: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = write()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const seed = (id: string, position: number, fields: Partial<QueuedMessageRow> = {}) => {
    const message = fields.body ?? body(id)
    insertJournalDomainQueueRow(db, target, {
      messageId: id,
      body: message,
      position,
      fingerprint: agentSessionSendBodyFingerprint('chat', message),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 1 },
      ...fields
    })
  }
  const consume = (messageId: string, clientMessageId: string) =>
    transaction(() =>
      applyJournalDomainSubmission(
        db,
        stateDirectory,
        target,
        {
          kind: 'submission',
          input: {
            clientMessageId,
            body: body(messageId),
            payloadFingerprint: agentSessionSendBodyFingerprint('chat', body(messageId)),
            fence: 1,
            handoverRecorded: true,
            origin: 'client',
            source: { kind: 'user' }
          },
          consume: { messageId, expect: 'waiting' }
        },
        {
          identity: {
            sessionId: 'chat',
            workspaceId: 'workspace',
            hostId: 'host',
            agent: 'codex',
            providerHandle: codexProviderHandle('thread')
          }
        },
        1_800_000_000_000
      )
    )
  const hold = (messageId: string) =>
    transaction(() =>
      applyJournalDomainEditLease(
        db,
        target,
        'phone-handle',
        {
          kind: 'acquire',
          callerKey: 'phone',
          editId: 'edit',
          messageId,
          fingerprint: agentSessionSendBodyFingerprint('chat', body(messageId))
        },
        Date.now()
      )
    )
  const read = (operation: QueueRead, facts: Partial<JournalSqlQueueFacts> = {}) =>
    readJournalSqlQueue(new JournalSqlScope(db, 'chat', 'epoch'), {
      ...operation,
      facts: { reopenFloor: null, ...facts }
    })
  return { db, seed, consume, hold, read }
}

const ids = (result: ReturnType<typeof readJournalSqlQueue>) =>
  result.kind === 'list' ? result.cards.map((card) => card.messageId) : result

it('lists current and still-owed handoff cards, and selects past persisted holds and mail', () => {
  const f = fixture()
  f.seed('withdrawn', 0, { state: 'withdrawn' })
  f.seed('sent', 1)
  f.seed('mail', 2, { body: { ...body('mail'), from } })
  f.seed('next', 3)
  f.consume('sent', 'send-1')

  expect(ids(f.read({ kind: 'list' }))).toEqual(['sent', 'mail', 'next'])
  expect(f.read({ kind: 'get', messageId: 'withdrawn' })).toMatchObject({
    card: { messageId: 'withdrawn', state: 'withdrawn' }
  })
  expect(f.read({ kind: 'revision' })).toEqual({ kind: 'revision', revision: 'epoch:11' })

  const next = (automatic: boolean, unavailable?: boolean) =>
    f.read(
      { kind: 'next-input-card', automatic, steer: false },
      unavailable === undefined ? {} : { mail: [[journalMailSenderKey(from), unavailable]] }
    )
  expect(next(true)).toEqual({ kind: 'mail-needed', from })
  expect(next(true, false)).toMatchObject({ card: { messageId: 'mail' } })
  expect(next(true, true)).toMatchObject({ card: { messageId: 'next' } })

  f.hold('mail')
  expect(next(true, false)).toEqual({ kind: 'next-input-card', card: null })
  expect(next(false, false)).toMatchObject({ card: { messageId: 'mail' } })
})

it('owes a reopen mark only for waiting cards or dispatched cards still awaiting delivery', () => {
  const f = fixture()
  f.seed('only', 1)
  expect(f.read({ kind: 'reopen-mark' })).toEqual({ kind: 'reopen-mark', awaits: true, since: 11 })
  f.consume('only', 'send-1')
  expect(f.read({ kind: 'reopen-mark' })).toEqual({ kind: 'reopen-mark', awaits: true, since: 12 })
  f.db.prepare(`UPDATE journal_submission_attempts SET dispatch_state='unknown', recovered=1`).run()
  expect(f.read({ kind: 'reopen-mark' })).toEqual({ kind: 'reopen-mark', awaits: false, since: 12 })
  expect(ids(f.read({ kind: 'list' }))).toEqual([])
})

it('derives Stop, clear and reopen pauses from head facts and exact clear membership', () => {
  const f = fixture()
  f.seed('cleared', 1)
  f.seed('kept', 2)
  f.db.exec(`UPDATE journal_chat_state SET queue_clear_sequence=8, queue_clear_operation_id='clear',
    queue_latest_stop_json='{"sequence":9,"event":{"reason":"user-stop","at":5}}';
    INSERT INTO journal_queue_clear_members VALUES('chat','epoch','cleared')`)
  const floor = { reopenFloor: { epoch: 'epoch', sequence: 7 } }

  expect(f.read({ kind: 'cleared-through' })).toEqual({ kind: 'cleared-through', sequence: 8 })
  expect(f.read({ kind: 'user-stop-in-force' })).toEqual({
    kind: 'user-stop-in-force',
    stop: { sequence: 9, event: { reason: 'user-stop', at: 5 } }
  })
  expect(f.read({ kind: 'pauses' }, floor)).toEqual({
    kind: 'pauses',
    pauses: [
      { reason: 'stopped', since: { epoch: 'epoch', sequence: 9 } },
      { reason: 'cleared', since: { epoch: 'epoch', sequence: 8 }, messageIds: ['cleared'] },
      {
        reason: 'restarted',
        since: { epoch: 'epoch', sequence: 7 },
        messageIds: ['cleared', 'kept']
      }
    ]
  })
})
