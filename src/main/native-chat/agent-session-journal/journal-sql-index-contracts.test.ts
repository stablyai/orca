import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalSqlIndexSchema } from './journal-sql-index-schema'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalInputPlaceIndex } from './input-order/journal-input-place-index'
import { JournalInputDomainIndex } from './input-order/journal-input-domain-index'
import { JournalInputReleasedPositions } from './input-order/journal-input-released-positions'
import { JournalInputCandidates } from './input-order/journal-input-candidates'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'
import { JournalSqlDomainIndex } from './journal-sql-domain-index'
import { JournalSqlReleasedPositions } from './journal-sql-released-positions'
import { JournalSqlCandidates } from './journal-sql-candidates'
import { JournalSqlTurnSources } from './journal-sql-turn-sources'
import type { JournalInputPlace } from './input-order/journal-input-order-state'
import type { TurnSource } from './input-order/journal-newest-turn-tree'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

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

function card(id: string, position: number, sequence = position): QueuedMessageRow {
  return {
    messageId: id,
    position,
    queuedAt: { epoch: 'epoch', sequence },
    body: { kind: 'message', role: 'user', blocks: [] },
    fingerprint: id,
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null
  }
}

function place(cut: number, basis: 'legacy' | 'observed'): JournalInputPlace {
  return {
    coordinate: { epoch: 'epoch', sequence: cut },
    context: { cut, basis, source: { epoch: 'epoch', sequence: cut } }
  }
}

it('keeps admission cuts, command-only selection and numeric positions through rollback', () => {
  const s = scope()
  const sql = new JournalSqlPlaceIndex(s, 'places')
  const memory = new JournalInputPlaceIndex('places')
  const first = card('z', 5, 2)
  const command = {
    ...card('a', 5, 2),
    body: { ...first.body, command: { name: 'compact' } }
  }
  for (const index of [sql, memory]) {
    index.set(first, true, false)
    index.set(command, true, true)
    index.setPosition('later-position', 99, 1, { epoch: 'other', sequence: 1 })
  }
  expect(sql.query('epoch', 2)).toEqual({ position: -Infinity })
  expect(sql.query('epoch', 3).head?.messageId).toBe('a')
  expect(sql.queryCommand('epoch', 3)?.messageId).toBe('a')
  expect(sql.allPlaces().position).toBe(99)
  expect(sql.idsAfter(1)).toEqual(['a', 'z'])
  expect([sql.firstPosition(), sql.lastId(), sql.successorId(1)]).toEqual([99, 'z', 'a'])
  expect(sql.query('epoch', 3)).toEqual(memory.query('epoch', 3))
  s.db.exec('SAVEPOINT command')
  sql.delete('a')
  expect(sql.queryCommand('epoch', 3)).toBeUndefined()
  s.db.exec('ROLLBACK TO command; RELEASE command')
  expect(sql.query('epoch', 3)).toEqual(memory.query('epoch', 3))
})

it('folds equal-position cards in introduction-block order and applies both legacy coordinates', () => {
  const s = scope()
  const sql = new JournalSqlDomainIndex(s, 'domain')
  const memory = new JournalInputDomainIndex()
  for (const index of [sql, memory]) {
    index.set(card('z', 7, 1), { introduced: 0, baseline: { coordinate: null } }, true, false)
    index.set(
      card('a', 7, 2),
      { introduced: 1, baseline: { coordinate: { epoch: 'epoch', sequence: 2 } } },
      true,
      true
    )
    index.set(card('ignored', 1), { introduced: 2 }, true, false)
  }
  const context = place(3, 'legacy').context
  expect(sql.query(context).head?.messageId).toBe('a')
  expect(sql.query(context)).toEqual(memory.query(context))
  const original = { epoch: 'old', sequence: 2 }
  const observed = { ...context, basis: 'observed' as const }
  expect(sql.query(observed).head?.messageId).toBe('z')
  expect(sql.query(context, original)).toEqual(memory.query(context, original))
  for (const index of [sql, memory]) {
    index.setPosition(card('a', 7, 2), {
      introduced: 1,
      baseline: { coordinate: { epoch: 'epoch', sequence: 2 } }
    })
  }
  expect(sql.query(context).handoff?.messageId).toBe('a')
  expect(sql.query(context)).toEqual(memory.query(context))
})

it('retains released positions with a pause frontier and a separate legacy fallback', () => {
  const s = scope()
  const sql = new JournalSqlReleasedPositions(s, 'release')
  const memory = new JournalInputReleasedPositions()
  for (const index of [sql, memory]) {
    index.add(
      card('old', 8),
      { introduced: 1, baseline: { coordinate: { epoch: 'epoch', sequence: 1 } } },
      2
    )
    index.pause(3)
    index.add(card('new', 4), {
      introduced: 1,
      baseline: { coordinate: { epoch: 'epoch', sequence: 1 } }
    })
  }
  expect(sql.query(place(2, 'observed'))).toEqual({ position: 4 })
  expect(sql.query(place(4, 'observed'))).toEqual({ position: 8 })
  expect(sql.query(place(3, 'legacy'))).toEqual({ position: -Infinity })
  expect(sql.query(place(4, 'legacy'))).toEqual({ position: 8 })
  for (const basis of ['legacy', 'observed'] as const) {
    for (const cut of [1, 2, 3, 4]) {
      expect(sql.query(place(cut, basis))).toEqual(memory.query(place(cut, basis)))
    }
  }
})

it('pages candidates without splitting equal-position ties or including the head position', () => {
  const s = scope()
  const sql = new JournalSqlCandidates(s, 'candidates')
  const memory = new JournalInputCandidates()
  for (const index of [sql, memory]) {
    index.set(card('head', 1), true)
    index.set(card('same-position', 1), true)
    index.set(card('z', 2), true)
    index.set(card('a', 2), true)
    index.set(card('removed', 3), true)
    index.set(card('removed', 3), false)
  }
  expect([...sql.after(card('head', 1))].map((row) => row.messageId)).toEqual(['a', 'z'])
  expect([...sql.after(card('head', 1))]).toEqual([...memory.after(card('head', 1))])
  for (let n = 32; n >= 0; n--) {
    sql.set(card(`tie-${String(n).padStart(2, '0')}`, 4), true)
  }
  sql.set(card('tail', 5), true)
  expect([...sql.after(card('z', 2))].map((row) => row.messageId)).toEqual([
    'tie-00',
    'tie-01',
    'tie-02',
    'tie-03',
    'tie-04',
    'tie-05',
    'tie-06',
    'tie-07',
    'tie-08',
    'tie-09',
    'tie-10',
    'tie-11',
    'tie-12',
    'tie-13',
    'tie-14',
    'tie-15',
    'tie-16',
    'tie-17',
    'tie-18',
    'tie-19',
    'tie-20',
    'tie-21',
    'tie-22',
    'tie-23',
    'tie-24',
    'tie-25',
    'tie-26',
    'tie-27',
    'tie-28',
    'tie-29',
    'tie-30',
    'tie-31',
    'tie-32',
    'tail'
  ])
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

it('selects the latest qualifying turn and live card beside retained records', () => {
  const size = 3
  const s = scope()
  const turns = new JournalSqlTurnSources(s)
  const memory = new MemoryJournalTurnSources()
  const places = new JournalSqlPlaceIndex(s, 'cards')
  s.db.exec('BEGIN')
  for (let n = 0; n < size; n++) {
    const source = turn(`refused-${n}`, n + 3, false, false)
    turns.set(source.item.itemId, source)
    memory.set(source.item.itemId, source)
    places.setPosition(`retained-${n}`, n)
  }
  const source = turn('ordinary', 1, true, true)
  turns.set('ordinary', source)
  memory.set('ordinary', source)
  places.set(card('waiting', size + 1), true, false)
  s.db.exec('COMMIT')
  expect(turns.winner()?.item.itemId).toBe('ordinary')
  expect(turns.winner()).toEqual(memory.winner())
  expect(turns.anchor()?.item.itemId).toBe('ordinary')
  expect(places.allPlaces().head?.messageId).toBe('waiting')
  turns.delete('ordinary')
  expect(turns.winner()).toBeUndefined()
})
