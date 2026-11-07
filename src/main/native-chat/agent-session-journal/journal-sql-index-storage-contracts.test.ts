import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import type { JournalIndexStorageFactory } from './journal-index-storage'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'
import { memoryJournalStateQueries } from './journal-memory-state-queries'
import { sqlJournalIndexStorage } from './journal-sql-index-storage'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlValueContext } from './journal-sql-value-context'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

/** Each call is one writer command: a fresh context over the same database. */
function sqlCommands() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlProjectionSchema())
  return (): { storage: JournalIndexStorageFactory; finish: () => void } => {
    const context = new JournalSqlValueContext(new JournalSqlScope(db, 'session', 'generation'))
    return {
      storage: sqlJournalIndexStorage({
        context,
        collections: {},
        stateQueries: memoryJournalStateQueries
      }),
      finish: () => context.flush()
    }
  }
}

function send(id: string, fence = 1): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence,
    dispatchState: 'pending',
    payloadFingerprint: 'fingerprint',
    providerItemId: null,
    reason: null,
    resolvedAt: null,
    submittedAt: 1,
    origin: 'client'
  }
}

function row(id: string, position: number): QueuedMessageRow {
  return {
    messageId: id,
    position,
    queuedAt: { epoch: 'generation', sequence: 1 },
    body: { kind: 'message', role: 'user', blocks: [] },
    fingerprint: id,
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null
  }
}

const ids = (values: Iterable<AgentJournalSubmission>) => [...values].map((v) => v.clientMessageId)

it('keeps Map insertion order, delete-then-set reinsertion and scalars across commands', () => {
  const command = sqlCommands()
  const memory = memoryJournalIndexStorage.orderFacts()
  let c = command()
  let sql = c.storage.orderFacts()
  for (const facts of [memory, sql]) {
    facts.queued.set('a', send('a'))
    facts.queued.set('b', send('b'))
    facts.queued.set('c', send('c'))
    facts.entered.set('x', send('x'))
    facts.revision++
  }
  c.finish()

  c = command()
  sql = c.storage.orderFacts()
  for (const facts of [memory, sql]) {
    // Recovery deletes then sets: the key moves to the end, as Map does.
    facts.queued.delete('a')
    facts.queued.set('a', send('a'))
    facts.queued.set('b', send('b2'))
    facts.recoveryOwed.add('z')
    facts.recoveryOwed.add('y')
  }
  c.finish()

  c = command()
  sql = c.storage.orderFacts()
  expect(sql.firstQueued()?.clientMessageId).toBe(memory.firstQueued()?.clientMessageId)
  expect(sql.queued.get('b')?.clientMessageId).toBe('b2')
  expect(ids(sql.enteredSubmissions())).toEqual(ids(memory.enteredSubmissions()))
  expect([...sql.recoveryOwedIds()]).toEqual([...memory.recoveryOwedIds()])
  expect([sql.revision, sql.queued.size]).toEqual([memory.revision, memory.queued.size])
})

it('rebuilds nested per-key indexes from membership, and drops them when emptied', () => {
  const command = sqlCommands()
  let c = command()
  let facts = c.storage.observationFacts()
  const index = c.storage.place('provider-inputs', 'provider-1')
  index.setPosition('send-1', 2)
  index.setPosition('send-2', 1)
  facts.providerInputs.set('provider-1', index)
  const members = c.storage.set<string>('signed-out-members', 7)
  members.add('send-1')
  facts.signedOutByFence.set(7, members)
  const otherFence = c.storage.set<string>('signed-out-members', 8)
  otherFence.add('send-1')
  facts.signedOutByFence.set(8, otherFence)
  c.finish()

  c = command()
  facts = c.storage.observationFacts()
  expect(facts.providerInputs.get('provider-1')?.successorId(-Infinity)).toBe('send-2')
  expect(facts.providerInputs.get('provider-2')).toBeUndefined()
  expect(facts.signedOutByFence.get(7)?.size).toBe(1)
  const signedOut = facts.signedOutByFence.get(7)!
  signedOut.delete('send-1')
  facts.signedOutByFence.delete(7)
  c.finish()

  c = command()
  expect(c.storage.observationFacts().signedOutByFence.has(7)).toBe(false)
  expect(c.storage.observationFacts().signedOutByFence.get(8)?.has('send-1')).toBe(true)
})

it('lists family members and phase members in insertion order with the same submission objects', () => {
  const command = sqlCommands()
  const memory = memoryJournalIndexStorage.linkFacts()
  const memoryFamily = memoryJournalIndexStorage.map<string, AgentJournalSubmission>('f', 'q')
  let c = command()
  const submissions = c.storage.map<string, AgentJournalSubmission>('submissions')
  const unsettled = c.storage.submissions('unsettled')
  let links = c.storage.linkFacts()
  const family = c.storage.map<string, AgentJournalSubmission>('link-family', 'q')
  for (const id of ['second', 'first', 'third']) {
    submissions.set(id, send(id))
    expect(unsettled.keep(id, submissions.get(id), true)).toBe(true)
    family.set(id, submissions.get(id)!)
    memoryFamily.set(id, send(id))
  }
  // The same live object is no change; a new incarnation is.
  expect(unsettled.keep('first', submissions.get('first'), true)).toBe(false)
  links.linked.set('q', family)
  memory.linked.set('q', memoryFamily)
  links.revision = 4
  c.finish()

  c = command()
  links = c.storage.linkFacts()
  const phase = c.storage.submissions('unsettled')
  const live = c.storage.map<string, AgentJournalSubmission>('submissions')
  expect([...links.familyMemberIds('q')]).toEqual([...memory.familyMemberIds('q')])
  expect([...links.familyMembers('q')][0]).toBe(live.get('second'))
  expect(ids(phase.list())).toEqual(['second', 'first', 'third'])
  expect(phase.keep('second', live.get('second'), true)).toBe(false)
  expect(phase.keep('second', undefined, false)).toBe(true)
  expect(ids(phase.list())).toEqual(['first', 'third'])
  expect(links.revision).toBe(4)
})

it('reads live queue rows in position then message id order across commands', () => {
  const command = sqlCommands()
  const memory = memoryJournalIndexStorage.queuedRows('cards')
  let c = command()
  let rows = c.storage.queuedRows('cards')
  let cards = c.storage.cardFacts()
  // More equal-position rows than one SQL page, written out of order, then one removed.
  const written = [
    ...Array.from({ length: 70 }, (_, n) => row(`tie-${String(69 - n).padStart(2, '0')}`, 2)),
    row('tail', 3),
    row('head', 1),
    row('gone', 2)
  ]
  for (const index of [memory, rows]) {
    for (const card of written) {
      index.set(card, true)
    }
    index.set(row('gone', 2), false)
  }
  cards.firstPosition = 1
  cards.lastPosition = 3
  cards.floor = { epoch: 'generation', sequence: 7 }
  c.finish()

  c = command()
  rows = c.storage.queuedRows('cards')
  cards = c.storage.cardFacts()
  const order = (values: Iterable<{ messageId: string }>) => [...values].map((v) => v.messageId)
  expect(order(rows.values())).toEqual(order(memory.values()))
  expect(order(rows.values()).slice(0, 3)).toEqual(['head', 'tie-00', 'tie-01'])
  expect(order(rows.values()).at(-1)).toBe('tail')
  expect(order(rows.values(row('tie-64', 2)))).toEqual([
    'tie-65',
    'tie-66',
    'tie-67',
    'tie-68',
    'tie-69',
    'tail'
  ])
  expect(rows.head()?.messageId).toBe('head')
  expect([cards.firstPosition, cards.lastPosition, cards.floor]).toEqual([
    1,
    3,
    { epoch: 'generation', sequence: 7 }
  ])
})
