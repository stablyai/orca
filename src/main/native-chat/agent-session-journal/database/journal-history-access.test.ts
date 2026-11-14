import { expect, it } from 'vitest'
import { createFixture } from '../store-lifecycle/journal-store-contract-test-fixture'
import {
  insertTestJournalRow,
  openTestJournalHostDatabase,
  seedLegacyTestJournal,
  updateTestJournalRowJson
} from '../store-lifecycle/journal-host-database-test-support'
import { journalPersonalStopEvidenceAfter } from '../context-epochs/journal-personal-stop'

const fixture = createFixture()

it('keeps incomplete history unknown and rechecks Stops after old-writer appends and corrections', async () => {
  const database = openTestJournalHostDatabase(fixture.root)
  seedLegacyTestJournal(database, { identity: fixture.IDENTITY, mintEpoch: () => 'epoch-1' })
  database.history!.retainSessions(['session-1'])
  const read = (turnId: string) =>
    journalPersonalStopEvidenceAfter(database.db, 'session-1', {
      cursor: { epoch: 'epoch-1', sequence: 1 },
      at: 0,
      turnId
    })
  const base = (seq: number) => ({ v: 4, epoch: 'epoch-1', seq, ts: seq, fence: 1 })
  database.transaction((db) => {
    for (let seq = 2; seq < 140; seq++) {
      insertTestJournalRow(db, 'session-1', {
        ...base(seq),
        kind: 'item',
        itemId: `status-${seq}`,
        revision: 1,
        body: { kind: 'status', text: 'Earlier work' }
      })
    }
    insertTestJournalRow(db, 'session-1', {
      ...base(140),
      kind: 'tombstone',
      itemId: 'stop-140',
      revision: 1,
      stopEvent: { reason: 'user-stop', turnId: 'turn-1', at: 140 }
    })
  })
  expect(read('turn-1')).toBe('unknown')
  expect(await database.history!.prepare('session-1')).toBe(true)
  expect(read('turn-1')).toBe('stopped')
  expect(read('turn-2')).toBe('clear')
  database.transaction((db) =>
    insertTestJournalRow(db, 'session-1', {
      ...base(141),
      kind: 'tombstone',
      itemId: 'stop-141',
      revision: 1,
      stopEvent: { reason: 'user-stop', turnId: 'turn-2', at: 141 }
    })
  )
  expect(read('turn-2')).toBe('unknown')
  await database.history!.prepare('session-1')
  expect(read('turn-2')).toBe('stopped')
  database.transaction((db) =>
    updateTestJournalRowJson(
      db,
      'session-1',
      141,
      JSON.stringify({
        ...base(141),
        kind: 'tombstone',
        itemId: 'stop-141',
        revision: 1,
        stopEvent: { reason: 'host-stop', at: 141 }
      })
    )
  )
  expect(read('turn-2')).toBe('unknown')
  await database.history!.prepare('session-1')
  expect(read('turn-2')).toBe('clear')
  database.transaction((db) =>
    updateTestJournalRowJson(
      db,
      'session-1',
      141,
      JSON.stringify({ ...base(141), kind: 'tombstone', stopEvent: null })
    )
  )
  await database.history!.prepare('session-1')
  expect(read('turn-2')).toBe('unknown')
})
