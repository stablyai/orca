import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { readJournalDomainUserStopInForce } from './journal-domain-queue-reads'
import {
  applyJournalDomainControlCommand,
  type JournalDomainControlOperation
} from './journal-domain-control-command'

const target = { sessionId: 'chat', epoch: 'epoch' }
const now = 1_800_000_000_000
const cleanups: (() => void)[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-domain-control-'))
  const db = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',10,1)`).run()
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return {
    db,
    control: (operation: JournalDomainControlOperation, savedAt = now) =>
      transaction(() => applyJournalDomainControlCommand(db, target, operation, {}, savedAt)),
    admitQueued: (id: string) => {
      const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
      transaction(() =>
        applyJournalDomainSubmission(
          db,
          directory,
          target,
          {
            kind: 'submission',
            input: {
              clientMessageId: id,
              body,
              payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
              fence: 1,
              origin: 'client',
              source: { kind: 'user' },
              handoverRecorded: true
            }
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
          now
        )
      )
    },
    write: (itemId: string, body: AgentJournalItemBody) =>
      transaction(() =>
        writeJournalDomainCurrentItem(db, target, {
          item: { itemId, revision: 1, sequence: 1, observedAt: now, body },
          hidden: false,
          ownerFence: 1
        })
      ),
    attempt: (id: string) => readJournalDomainSubmissionAttempt(db, target, id)?.submission,
    head: () =>
      db
        .prepare(`SELECT last_sequence, queue_latest_stop_json, queue_manual_stop_json
        FROM journal_chat_state`)
        .get()!,
    events: () => Number(db.prepare('SELECT COUNT(*) AS n FROM journal_events').get()!.n)
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('withdraws host-held sends and records the live turn Stop in one write', () => {
  const f = fixture()
  f.admitQueued('first')
  f.admitQueued('second')
  const accepted = f.control(
    { kind: 'stop-accept', event: { reason: 'user-stop' }, fence: 1, liveTurnId: 'turn-1' },
    now + 5
  )
  expect(accepted.value).toEqual({
    mark: { epoch: 'epoch', sequence: 15 },
    withdrawn: ['first', 'second'],
    turnId: 'turn-1'
  })
  expect(accepted.coordinates.at(-1)).toEqual({ kind: 'tombstone', epoch: 'epoch', seq: 15 })
  for (const id of ['first', 'second']) {
    expect(f.attempt(id)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled', neverReachedAgent: true }
    })
  }
  const stop = { sequence: 15, event: { reason: 'user-stop', turnId: 'turn-1', at: now + 5 } }
  expect(JSON.parse(String(f.head().queue_latest_stop_json))).toEqual(stop)
  expect(JSON.parse(String(f.head().queue_manual_stop_json))).toEqual(stop)
  expect(readJournalDomainUserStopInForce(f.db, target)).toEqual(stop)

  f.control({ kind: 'stop', event: { reason: 'host-stop' }, fence: 1 }, now + 6)
  expect(JSON.parse(String(f.head().queue_manual_stop_json))).toEqual(stop)
  f.control({ kind: 'queue-resume', fence: 1 })
  expect(readJournalDomainUserStopInForce(f.db, target)).toBeNull()
})

it('rolls back every withdrawal and the Stop when one withdrawal fails', () => {
  const f = fixture()
  f.admitQueued('first')
  f.admitQueued('broken')
  f.db
    .exec(`CREATE TRIGGER reject_broken BEFORE UPDATE OF payload_json ON journal_submission_attempts
    WHEN NEW.message_id='broken' BEGIN SELECT RAISE(ABORT, 'dispatch unavailable'); END`)
  const before = { head: f.head(), events: f.events() }
  expect(() =>
    f.control({ kind: 'stop-accept', event: { reason: 'user-stop' }, fence: 1, liveTurnId: null })
  ).toThrow('dispatch unavailable')
  expect(f.attempt('first')?.dispatchState).toBe('pending')
  expect({ head: f.head(), events: f.events() }).toEqual(before)
})

it('marks reopen only while a card waits', () => {
  const f = fixture()
  const before = { head: f.head(), events: f.events() }
  const skipped = f.control({ kind: 'queue-reopen-mark', fence: 1, since: 4 })
  expect(skipped).toMatchObject({ value: null, coordinates: [] })
  expect({ head: f.head(), events: f.events() }).toEqual(before)
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  insertJournalDomainQueueRow(f.db, target, {
    messageId: 'card',
    body,
    position: 1,
    fingerprint: agentSessionSendBodyFingerprint('chat', body),
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: { epoch: 'epoch', sequence: 1 }
  })
  expect(f.control({ kind: 'queue-reopen-mark', fence: 1, since: 4 }).value).toBe(4)
  expect(
    Number(f.db.prepare('SELECT queue_reopened_sequence AS n FROM journal_chat_state').get()!.n)
  ).toBe(4)
})

it('explains a quit only for an interrupted turn whose cut is absent', () => {
  const f = fixture()
  const cut = {
    kind: 'shutdown-cut' as const,
    input: {
      identity: { provider: 'orca' as const, clientMessageId: 'quit' },
      body: { kind: 'status' as const, text: 'Orca quit' },
      turnItemId: 'turn-item',
      fence: 1
    }
  }
  f.write('turn-item', { kind: 'turn', turnId: 'turn-1', state: 'completed', outcome: 'success' })
  const sequence = Number(f.head().last_sequence)
  expect(f.control(cut)).toMatchObject({ value: null, coordinates: [] })
  f.write('turn-item', { kind: 'turn', turnId: 'turn-1', state: 'interrupted' })
  const written = f.control(cut)
  expect(written.value).toEqual({
    cursor: { epoch: 'epoch', sequence: sequence + 1 },
    itemId: 'orca:quit',
    revision: 1
  })
  expect(written.items[0]).toMatchObject({
    itemId: 'orca:quit',
    turnScope: { kind: 'turn', turnItemId: 'turn-item' }
  })
  expect(f.control(cut)).toMatchObject({ value: null, coordinates: [] })
  expect(Number(f.head().last_sequence)).toBe(sequence + 1)
})
