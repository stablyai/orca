import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  stageTestJournalRowReceipt,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import { journalInputOrder } from './journal-input-order'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import { renderJournalState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  expectProjectionMatches
} from './journal-projection-test-support'

let root: string
let database: Awaited<ReturnType<typeof openTestJournalHostDatabase>>
let rig: ReturnType<typeof projectionWriter>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-failure-'))
  database = await openTestJournalHostDatabase(root)
})
afterEach(async () => {
  rig?.queue.markClosed()
  await rig?.queue.drain()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([
  ['outcome', 'BEFORE INSERT ON journal_outcomes'],
  ['coverage', 'BEFORE UPDATE ON journal_outcome_epochs'],
  ['native receipt', 'BEFORE INSERT ON agent_session_command_receipts']
])('rolls back a multirow projection on %s failure, then retries', async (_name, point) => {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue' }]
  }
  const send =
    (id: string) =>
    (seq: number, ts: number): JournalRow => ({
      ...base(seq),
      ts,
      kind: 'submission',
      clientMessageId: id,
      body,
      handoverRecorded: true,
      inputOrderContext: { source: { epoch, sequence: seq }, basis: 'observed', cut: seq },
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body)
    })
  seedOutcomeRows(database, [projectionEpochRow, send('original')(2, 1002)])
  rig = projectionWriter(database, restoreJournal(database.db, sessionId)!.state)
  writeCommandReceiptTestRecord(database.db, sessionId)
  const before = encodeJournalState(rig.state())
  const published = renderJournalState(rig.state())
  const retained = [...rig.state().inputs.sources]
  const ownership = () =>
    [...journalInputOrder(rig.state()).unsettledSubmissions()].map((send) => send.clientMessageId)
  expect(ownership()).toEqual(['original'])
  const receipts = () => database.db.prepare('SELECT * FROM agent_session_command_receipts').all()
  const savedReceipts = receipts()
  const persisted = () => ({
    outcomes: database.db
      .prepare('SELECT * FROM journal_outcomes ORDER BY generation,seq,field,entry_key')
      .all(),
    coverage: database.db.prepare('SELECT * FROM journal_outcome_epochs').all()
  })
  const saved = persisted()
  const attempt = () =>
    rig.writer.enqueueRows(
      () => [
        (seq, ts): JournalRow => ({
          ...base(seq),
          ts,
          kind: 'dispatch',
          clientMessageId: 'original',
          state: 'accepted',
          providerItemId: null,
          reason: null
        }),
        send('retry')
      ],
      {
        write: (plan, row) => stageTestJournalRowReceipt(plan, sessionId, row),
        committed: () => {}
      },
      (rows) => rows.at(-1)
    )

  database.db.exec(`CREATE TRIGGER projection_failure ${point}
    BEGIN SELECT RAISE(ABORT, 'projection failed'); END`)
  await expect(attempt()).rejects.toThrow('projection failed')
  database.db.exec('DROP TRIGGER projection_failure')
  expect(encodeJournalState(rig.state())).toEqual(before)
  expect(renderJournalState(rig.state())).toEqual(published)
  expect(ownership()).toEqual(['original'])
  expect([...rig.state().inputs.sources]).toEqual(retained)
  expect(receipts()).toEqual(savedReceipts)
  expect(persisted()).toEqual(saved)
  expectProjectionMatches(database, rig.state())

  await expect(attempt()).resolves.toHaveLength(2)
  expect(rig.state().submissions.get('original')?.dispatchState).toBe('accepted')
  expect(ownership()).toEqual(['retry'])
  expect(renderJournalState(rig.state()).cursor.sequence).toBe(4)
  expect(receipts()).toHaveLength(savedReceipts.length + 1)
  expectProjectionMatches(database, rig.state())
})
