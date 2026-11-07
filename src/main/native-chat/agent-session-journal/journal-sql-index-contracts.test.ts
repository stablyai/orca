import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalSqlIndexSchema } from './journal-sql-index-schema'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalInputPlaceIndex } from './input-order/journal-input-place-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import { JournalSqlTurnSources } from './journal-sql-turn-sources'
import type { TurnSource } from './input-order/journal-newest-turn-tree'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function scope() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlIndexSchema())
  return new JournalSqlScope(db, 'session', 'generation')
}

it('keeps numeric positions, edges and tie order through rollback', () => {
  const s = scope()
  const sql = new JournalSqlPlaceIndex(s, 'places')
  const memory = new JournalInputPlaceIndex('places')
  const both: JournalInputPlaceStorage[] = [sql, memory]
  for (const index of both) {
    index.setPosition('z', 2)
    index.setPosition('a', 2)
    index.setPosition('later-position', 99, 1)
  }
  const read = (index: JournalInputPlaceStorage) => [
    index.allPlaces().position,
    index.idsAfter(1),
    index.lastId(),
    index.successorId(1)
  ]
  expect(read(sql)).toEqual([99, ['a', 'z', 'later-position'], 'later-position', 'a'])
  expect(read(sql)).toEqual(read(memory))
  s.db.exec('SAVEPOINT command')
  sql.delete('later-position')
  expect(sql.allPlaces().position).toBe(2)
  s.db.exec('ROLLBACK TO command; RELEASE command')
  expect(read(sql)).toEqual(read(memory))
})

function turn(id: string, sequence: number, ordinary: boolean, relevant: boolean): TurnSource {
  return {
    item: {
      itemId: id,
      sequence,
      sequenceIndex: 0,
      revision: 1,
      observedAt: 1,
      body: { kind: 'turn', turnId: id, state: 'completed', outcome: 'failure' }
    },
    failedAt: 2,
    ordinary,
    relevant
  }
}

it('selects the latest qualifying turn beside retained records', () => {
  const size = 3
  const s = scope()
  const turns = new JournalSqlTurnSources(s)
  const memory = new MemoryJournalTurnSources()
  s.db.exec('BEGIN')
  for (let n = 0; n < size; n++) {
    const source = turn(`refused-${n}`, n + 3, false, false)
    turns.set(source.item.itemId, source)
    memory.set(source.item.itemId, source)
  }
  const source = turn('ordinary', 1, true, true)
  turns.set('ordinary', source)
  memory.set('ordinary', source)
  s.db.exec('COMMIT')
  expect(turns.winner()?.item.itemId).toBe('ordinary')
  expect(turns.winner()).toEqual(memory.winner())
  expect(turns.anchor()?.item.itemId).toBe('ordinary')
  turns.delete('ordinary')
  expect(turns.winner()).toBeUndefined()
})
