import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { JournalSqlScope } from './journal-sql-scope'
import { journalSqlValueSchema } from './journal-sql-value-schema'
import { journalSqlInputEntitySchema } from './journal-sql-input-entity-schema'
import { JournalSqlValueContext } from './journal-sql-value-context'
import { JournalSqlKeyedMap, JournalSqlKeyedSet } from './journal-sql-keyed-values'
import { journalSqlIndexSchema } from './journal-sql-index-schema'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'
import type { QueuedMessageRow } from './queued-message-table'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlValueSchema() + journalSqlInputEntitySchema())
  const context = () => new JournalSqlValueContext(new JournalSqlScope(db, 'session', 'generation'))
  return { db, context }
}

type Send = { status: string; flags: { recovered: boolean }; coverage?: string[] }
const send = (status: string): Send => ({ status, flags: { recovered: false } })

function maps(context: JournalSqlValueContext) {
  return {
    source: new JournalSqlKeyedMap<string, Send>(context, 'fixture.sends'),
    alias: new JournalSqlKeyedMap<string, Send>(context, 'inputs.candidates')
  }
}

it.each([false, true])(
  'preserves submission aliases and replaced snapshots after bulk import=%s',
  (bulk) => {
    const f = fixture()
    let command = f.context()
    let { source, alias } = maps(command)
    const seed = () => {
      source.set('send', send('pending'))
      alias.set('send', source.get('send')!)
      expect(alias.get('send')).toBe(source.get('send'))
    }
    if (bulk) {
      command.bulkLoad(seed)
    } else {
      seed()
    }
    command.flush()

    command = f.context()
    ;({ source, alias } = maps(command))
    const candidate = alias.get('send')!
    expect(candidate).toBe(source.get('send'))
    candidate.status = 'unknown'
    candidate.flags.recovered = true
    candidate.coverage = ['first']
    candidate.coverage.push('second')
    command.flush()
    expect(command.changes().map((change) => change.path)).toEqual([
      'inputs.candidates',
      'fixture.sends'
    ])

    command = f.context()
    ;({ source, alias } = maps(command))
    expect(source.get('send')).toEqual({
      status: 'unknown',
      flags: { recovered: true },
      coverage: ['first', 'second']
    })
    source.set('send', send('accepted'))
    expect(alias.get('send')).toEqual({
      status: 'unknown',
      flags: { recovered: true },
      coverage: ['first', 'second']
    })
    alias.get('send')!.status = 'old-attempt'
    command.flush()

    command = f.context()
    ;({ source, alias } = maps(command))
    expect(source.get('send')!.status).toBe('accepted')
    expect(alias.get('send')!.status).toBe('old-attempt')
    alias.set('send', source.get('send')!)
    command.flush()
    expect(alias.get('send')).toBe(source.get('send'))
    expect(f.db.prepare('SELECT incarnation FROM journal_proj_value_snapshots').all()).toEqual([])
  }
)

it('keeps a source captured before replacement when a later alias first refers to it', () => {
  const f = fixture()
  const command = f.context()
  const { source, alias } = maps(command)
  source.set('send', send('first'))
  const original = source.get('send')!
  source.set('send', send('second'))
  alias.set('old', original)
  command.flush()
  const next = maps(f.context())
  expect(next.source.get('send')!.status).toBe('second')
  expect(next.alias.get('old')!.status).toBe('first')
})

it.each([false, true])('keeps nested shared objects after bulk import=%s', (bulk) => {
  const f = fixture()
  let command = f.context()
  let { source } = maps(command)
  const seed = () => {
    source.set('send', send('first'))
    const first = source.get('send')!
    const flags = first.flags
    source.set('other', { status: 'second', flags })
  }
  if (bulk) {
    command.bulkLoad(seed)
  } else {
    seed()
  }
  command.flush()

  command = f.context()
  ;({ source } = maps(command))
  const other = source.get('other')!
  const original = source.get('send')!
  expect(other.flags).toBe(original.flags)
  other.flags.recovered = true
  command.flush()
  expect(maps(f.context()).source.get('send')!.flags.recovered).toBe(true)
})

it('rolls back SQL mutations and object writes together when the command context is discarded', () => {
  const f = fixture()
  const seed = f.context()
  const original = maps(seed)
  original.source.set('send', send('pending'))
  original.alias.set('send', original.source.get('send')!)
  seed.flush()
  f.db.exec('SAVEPOINT command')
  const command = f.context()
  const pending = maps(command)
  pending.alias.get('send')!.flags.recovered = true
  pending.source.delete('send')
  pending.source.set('new', send('new'))
  command.flush()
  f.db.exec('ROLLBACK TO command; RELEASE command')
  const restored = maps(f.context())
  expect(restored.source.size).toBe(1)
  expect(restored.source.has('new')).toBe(false)
  expect(restored.alias.get('send')).toEqual({ status: 'pending', flags: { recovered: false } })
})

it('preserves undefined entries, membership, reinsert order and change-record order', () => {
  const f = fixture()
  const command = f.context()
  const map = new JournalSqlKeyedMap<string, unknown>(command, 'itemEchoes')
  const set = new JournalSqlKeyedSet<string>(command, 'inputs.ended')
  map.set('a', undefined)
  map.set('b', null)
  map.delete('a')
  map.set('a', undefined)
  set.add('first')
  set.add('second')
  set.add('first')
  expect([map.size, map.has('a'), map.get('a'), set.size]).toEqual([2, true, undefined, 2])
  expect(
    command.changes().map(({ path, key, deleted, reinsert }) => ({ path, key, deleted, reinsert }))
  ).toEqual([
    { path: 'itemEchoes', key: 'b', deleted: false, reinsert: true },
    { path: 'itemEchoes', key: 'a', deleted: false, reinsert: true },
    { path: 'inputs.ended', key: 'first', deleted: false, reinsert: true },
    { path: 'inputs.ended', key: 'second', deleted: false, reinsert: true }
  ])
  command.flush()
  const reloaded = new JournalSqlKeyedMap<string, unknown>(f.context(), 'itemEchoes')
  expect([reloaded.has('a'), reloaded.get('a')]).toEqual([true, undefined])
  expect(
    f.db
      .prepare(`SELECT entry_key FROM journal_proj_values
    WHERE collection='itemEchoes' ORDER BY ordinal`)
      .all()
  ).toEqual([{ entry_key: '"b"' }, { entry_key: '"a"' }])
})

it('materializes indexed cards through their source incarnation across commands', () => {
  const f = fixture()
  f.db.exec(journalSqlIndexSchema())
  let command = f.context()
  let cards = new JournalSqlKeyedMap<string, QueuedMessageRow>(command, 'queue.cards')
  cards.set('card', {
    messageId: 'card',
    position: 2,
    queuedAt: null,
    body: { kind: 'message', role: 'user', blocks: [] },
    fingerprint: 'card',
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null
  })
  new JournalSqlPlaceIndex(command.indexScope(), 'cards').set(cards.get('card')!, true, false)
  command.flush()

  command = f.context()
  cards = new JournalSqlKeyedMap(command, 'queue.cards')
  const index = new JournalSqlPlaceIndex(command.indexScope(), 'cards')
  const original = cards.get('card')!
  original.returnedReason = 'late'
  expect(index.allPlaces().head).toBe(original)
  expect(index.allPlaces().head!.returnedReason).toBe('late')
  cards.set('card', { ...original, returnedReason: 'replacement' })
  command.flush()

  command = f.context()
  cards = new JournalSqlKeyedMap(command, 'queue.cards')
  const restored = new JournalSqlPlaceIndex(command.indexScope(), 'cards')
  expect([restored.allPlaces().head!.returnedReason, cards.get('card')!.returnedReason]).toEqual([
    'late',
    'replacement'
  ])
  restored.set(cards.get('card')!, true, false)
  command.flush()
  expect(restored.allPlaces().head).toBe(cards.get('card'))
  restored.delete('card')
  expect(restored.allPlaces().head).toBeUndefined()
})
