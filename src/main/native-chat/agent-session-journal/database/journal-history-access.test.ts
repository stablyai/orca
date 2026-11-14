import { expect, it, vi } from 'vitest'
import { createFixture } from '../store-lifecycle/journal-store-contract-test-fixture'
import {
  insertTestJournalRow,
  openTestJournalHostDatabase,
  seedLegacyTestJournal,
  updateTestJournalRowJson
} from '../store-lifecycle/journal-host-database-test-support'
import { journalPersonalStopEvidenceAfter } from '../context-epochs/journal-personal-stop'
import { AgentSessionRecoveryCapsule } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { createRestartEvidenceReader } from '../../agent-session-wire/recovery/structured-agent-session-restart-evidence'
import {
  marker,
  NOW
} from '../../agent-session-wire/recovery/testing/structured-agent-session-restart-resume-test-harness'

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

it('uses current Stop evidence after the final capsule inventory await', async () => {
  const database = openTestJournalHostDatabase(fixture.root)
  seedLegacyTestJournal(database, { identity: fixture.IDENTITY, mintEpoch: () => 'epoch-1' })
  const capsule = new AgentSessionRecoveryCapsule(fixture.root)
  await capsule.record([marker({ sessionId: 'session-1' })], NOW)
  const read = createRestartEvidenceReader({
    capsule,
    database,
    loaded: () => false,
    provider: () => 'codex',
    logger: { warn: () => undefined, error: () => undefined },
    now: () => NOW
  })
  const evidence = () =>
    journalPersonalStopEvidenceAfter(database.db, 'session-1', {
      cursor: { epoch: 'epoch-1', sequence: 1 },
      at: 0,
      turnId: 'turn-1'
    })
  expect(await read('pending', undefined, evidence)).toBe('clear')
  const inventory = capsule.inventory.bind(capsule)
  let calls = 0
  const changed = vi.spyOn(capsule, 'inventory').mockImplementation(async (...args) => {
    const result = await inventory(...args)
    if (++calls === 2) {
      database.transaction((db) =>
        insertTestJournalRow(db, 'session-1', {
          v: 4,
          epoch: 'epoch-1',
          seq: 2,
          ts: 2,
          fence: 1,
          kind: 'tombstone',
          itemId: 'stop-2',
          revision: 1,
          stopEvent: { reason: 'user-stop', turnId: 'turn-1', at: 2 }
        })
      )
    }
    return result
  })
  expect(await read('pending', undefined, evidence)).toBe('unknown')
  changed.mockRestore()
  expect(await read('pending', undefined, evidence)).toBe('stopped')
  calls = 0
  const corrected = vi.spyOn(capsule, 'inventory').mockImplementation(async (...args) => {
    const result = await inventory(...args)
    if (++calls === 2) {
      database.transaction((db) =>
        updateTestJournalRowJson(
          db,
          'session-1',
          2,
          JSON.stringify({
            v: 4,
            epoch: 'epoch-1',
            seq: 2,
            ts: 2,
            fence: 1,
            kind: 'tombstone',
            itemId: 'stop-2',
            revision: 1,
            stopEvent: { reason: 'host-stop', at: 2 }
          })
        )
      )
    }
    return result
  })
  expect(await read('pending', undefined, evidence)).toBe('unknown')
  corrected.mockRestore()
  expect(await read('pending', undefined, evidence)).toBe('clear')
})
