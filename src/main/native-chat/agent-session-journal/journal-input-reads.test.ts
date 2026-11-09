import { expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { journalDatabasePath } from './database/journal-host-database'
import { convertJournalSqlProjection } from './journal-domain-single-connection-import.test-fixture'
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import type { JournalInputRead, JournalInputReadResult } from './journal-input-reads'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { createFixture } from './queued-messages/journal-unsent-send-hold-contract-test-fixture'
import { openTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'

const fixture = createFixture()

const READS: JournalInputRead[] = [
  { kind: 'first-queued' },
  { kind: 'entered-submissions' },
  { kind: 'sending-submissions' },
  { kind: 'recoverable-submissions' },
  { kind: 'pending-submissions' },
  { kind: 'recovered-unknown-ids' },
  { kind: 'linked-to', messageId: 'card' },
  { kind: 'linked-to', messageId: 'missing' },
  { kind: 'latest-accepted-handover' },
  { kind: 'input-for-item', itemId: 'orca:accepted' },
  { kind: 'input-for-item', itemId: 'orca:missing' },
  { kind: 'input-ordinal', clientMessageId: 'unknown' },
  { kind: 'input-ordinal', clientMessageId: 'missing' },
  { kind: 'input-count' },
  { kind: 'sent-after', sequence: 0 },
  { kind: 'sent-after', sequence: 1_000 },
  { kind: 'accepted-after', sequence: 0 },
  { kind: 'accepted-inputs-after', sequence: 0 },
  { kind: 'signed-out-at', fence: 0 },
  { kind: 'signed-out-at', fence: 7 },
  { kind: 'submission-at', sequence: 1_000 },
  { kind: 'stopped-history-inputs', excluding: 'accepted' },
  { kind: 'newest-turn' },
  {
    kind: 'batch',
    reads: [{ kind: 'linked-to', messageId: 'card' }, { kind: 'latest-accepted-handover' }]
  },
  { kind: 'accepted-submissions' },
  { kind: 'capture-keys', present: ['rendered-only', 'orca:accepted'] },
  { kind: 'unsettled-submissions' },
  {
    kind: 'batch',
    reads: [
      { kind: 'accepted-submissions' },
      { kind: 'capture-keys', present: [] },
      { kind: 'unsettled-submissions' }
    ]
  }
]

function ids(result: JournalInputReadResult): string[] {
  return 'submissions' in result ? result.submissions.map((entry) => entry.clientMessageId) : []
}

it('answers every input-evidence read from a readonly snapshot exactly as the in-memory chat does', async () => {
  const journal = await fixture.open()
  for (const id of ['accepted', 'pending', 'signed-out', 'unknown']) {
    await fixture.accept(journal, id)
  }
  await journal.resolveDispatch({
    clientMessageId: 'accepted',
    fence: 0,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'accepted-echo' }
  })
  await journal.resolveDispatch({
    clientMessageId: 'signed-out',
    fence: 0,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'rejection' })
  })
  await journal.resolveDispatch({
    clientMessageId: 'unknown',
    fence: 0,
    state: 'unknown',
    recovered: true
  })
  await journal.queuedMessages.insert({ messageId: 'card', body: fixture.message('linked') })
  await journal.appendSubmission(
    {
      clientMessageId: 'linked',
      payloadFingerprint: (await journal.queuedMessages.get('card'))!.fingerprint,
      body: fixture.message('linked'),
      fence: 0,
      handoverRecorded: true
    },
    { messageId: 'card', expect: 'waiting' }
  )
  const before = await journal.reads.input({ kind: 'capture-keys', present: [] })
  await journal.appendSubmission({
    clientMessageId: 'legacy:raw/%',
    payloadFingerprint: fixture.fingerprint(fixture.message('legacy')),
    body: fixture.message('legacy'),
    fence: 0
  })
  expect(before.keys).not.toContain('orca:legacy%3Araw%2F%25')
  const memory = await Promise.all(READS.map((read) => journal.reads.input(read)))
  await journal.close()

  openTestJournalHostDatabase(fixture.root).transaction((db) =>
    convertJournalSqlProjection(db, fixture.IDENTITY.sessionId)
  )
  const db = new Database(journalDatabasePath(fixture.root), { readonly: true })
  try {
    const sql = READS.map((read) =>
      readJournalSqlProjection(db, fixture.IDENTITY.sessionId, (scope) =>
        readJournalSqlInput(scope, read)
      )
    )
    // Answers cross a worker port, so none may hold a storage proxy.
    expect(structuredClone(sql)).toEqual(sql)
    expect(sql).toEqual(memory)
  } finally {
    db.close()
  }

  const answer = (kind: JournalInputRead['kind']) => memory[READS.findIndex((r) => r.kind === kind)]
  expect(ids(answer('recoverable-submissions'))).toEqual(['pending', 'linked', 'legacy:raw/%'])
  expect(ids(answer('pending-submissions'))).toEqual(['pending', 'linked', 'legacy:raw/%'])
  expect(ids(answer('accepted-submissions'))).toEqual([
    'accepted',
    'pending',
    'signed-out',
    'unknown',
    'linked'
  ])
  expect(answer('accepted-submissions')).toMatchObject({ latestReceiptSequence: 6 })
  expect(ids(answer('unsettled-submissions'))).toEqual([
    'pending',
    'unknown',
    'linked',
    'legacy:raw/%'
  ])
  expect(answer('capture-keys')).toEqual({
    kind: 'capture-keys',
    keys: [
      'orca:accepted',
      'orca:legacy%3Araw%2F%25',
      'orca:linked',
      'orca:pending',
      'orca:signed-out',
      'orca:unknown',
      'rendered-only'
    ]
  })
  expect(answer('recovered-unknown-ids')).toEqual({
    kind: 'recovered-unknown-ids',
    ids: ['unknown']
  })
  expect(ids(answer('linked-to'))).toEqual(['linked'])
  expect(memory[12]).toEqual({ kind: 'input-ordinal', ordinal: Infinity })
  expect(answer('input-count')).toEqual({ kind: 'input-count', count: 6 })
  expect(memory[18]).toEqual({ kind: 'signed-out-at', answer: true })
  expect(memory[19]).toEqual({ kind: 'signed-out-at', answer: false })
})
