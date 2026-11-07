import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { afterEach, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import Database from '../../sqlite/sync-database'
import { ensureJournalOutcomeTables } from './outcomes/journal-outcome-format'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlItemValues } from './journal-sql-item-values'
import { JournalSqlValueContext } from './journal-sql-value-context'
import { JournalSqlKeyedMap } from './journal-sql-keyed-values'
import { JournalSqlTurnSources } from './journal-sql-turn-sources'

/** Turn sources are the item family's real holder: each captures its whole item. */
function capturedItems(context: JournalSqlValueContext) {
  const sources = new JournalSqlTurnSources(context.indexScope())
  return {
    get: (id: string) => sources.get(id)?.item,
    set: (id: string, item: AgentJournalRenderItem) =>
      sources.set(id, { item, failedAt: item.sequence, ordinary: true, relevant: true }),
    delete: (id: string) => sources.delete(id)
  }
}

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlProjectionSchema())
  ensureJournalOutcomeTables(db)
  const command = () => {
    const scope = new JournalSqlScope(db, 'session', 'projection')
    const payloads = new JournalSqlItemValues(scope)
    const context = new JournalSqlValueContext(scope, payloads)
    return {
      scope,
      context,
      payloads,
      items: new JournalSqlKeyedMap<string, AgentJournalRenderItem>(context, 'items'),
      captured: capturedItems(context)
    }
  }
  function save(c: ReturnType<typeof command>, itemId: string, seq: number) {
    c.context.flush()
    db.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (1, ?, 'items', ?, 2, 's0000000000000001:0000000000000000', ?, 0)`).run(
      seq,
      JSON.stringify(itemId),
      JSON.stringify(c.items.get(itemId), c.context.untracked)
    )
    c.payloads.bind(1, seq)
  }
  return { db, command, save }
}

function item(itemId: string, text: string, revision = 0): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: 2,
    observedAt: 100,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

it('reads saved bodies through outcome pointers, keeps inline prefixes, and restores after rollback', () => {
  const f = fixture()
  let c = f.command()
  c.items.set('saved', item('saved', 'original'))
  c.items.set('prefix', item('prefix', 'prefix-only'))
  f.save(c, 'saved', 2)
  expect(
    f.db
      .prepare(`SELECT outcome_generation, outcome_seq, inline_json
    FROM journal_proj_item_versions WHERE entry_key='"saved"'`)
      .get()
  ).toEqual({
    outcome_generation: 1,
    outcome_seq: 2,
    inline_json: null
  })
  c = f.command()
  expect(c.items.get('saved')).toEqual(item('saved', 'original'))
  expect(c.items.get('prefix')).toEqual(item('prefix', 'prefix-only'))
  f.db.exec('SAVEPOINT command')
  c.items.set('saved', item('saved', 'rolled back', 1))
  f.save(c, 'saved', 3)
  f.db.exec('ROLLBACK TO command; RELEASE command')
  c = f.command()
  expect(c.items.get('saved')).toEqual(item('saved', 'original'))
  expect(c.items.size).toBe(2)
  expect(f.db.prepare('SELECT seq FROM journal_outcomes ORDER BY seq').all()).toEqual([{ seq: 2 }])
})

it('keeps replaced item incarnations as pointers and prunes them when references disappear', () => {
  const f = fixture()
  let c = f.command()
  c.items.set('saved', item('saved', 'original'))
  c.captured.set('old', c.items.get('saved')!)
  f.save(c, 'saved', 2)
  c = f.command()
  c.items.set('saved', item('saved', 'replacement', 1))
  f.save(c, 'saved', 3)
  c = f.command()
  expect(c.captured.get('old')).toEqual(item('saved', 'original'))
  expect(c.items.get('saved')).toEqual(item('saved', 'replacement', 1))
  expect(
    f.db
      .prepare(`SELECT outcome_seq, inline_json FROM journal_proj_item_versions
    ORDER BY incarnation`)
      .all()
  ).toEqual([
    { outcome_seq: 2, inline_json: null },
    { outcome_seq: 3, inline_json: null }
  ])
  c.captured.delete('old')
  c.context.flush()
  expect(f.db.prepare('SELECT outcome_seq FROM journal_proj_item_versions').all()).toEqual([
    { outcome_seq: 3 }
  ])
  c.items.delete('saved')
  expect(f.db.prepare('SELECT incarnation FROM journal_proj_item_versions').all()).toEqual([])
  expect(f.db.prepare('SELECT entry_key FROM journal_proj_items').all()).toEqual([])
  expect(f.db.prepare('SELECT seq FROM journal_outcomes ORDER BY seq').all()).toEqual([
    { seq: 2 },
    { seq: 3 }
  ])
})

it('preserves writes through captured items and captures made after their source is replaced', () => {
  const f = fixture()
  let c = f.command()
  c.items.set('saved', item('saved', 'original'))
  f.save(c, 'saved', 2)
  c = f.command()
  const previous = c.items.get('saved')!
  c.items.set('saved', item('saved', 'replacement', 1))
  c.captured.set('old', previous)
  f.save(c, 'saved', 3)
  c = f.command()
  c.captured.get('old')!.observedAt = 999
  c.context.flush()
  c = f.command()
  expect(c.captured.get('old')!.observedAt).toBe(999)
  expect(c.items.get('saved')!.observedAt).toBe(100)
  c.captured.set('live', c.items.get('saved')!)
  c.context.flush()
  c = f.command()
  c.captured.get('live')!.revision = 2
  f.save(c, 'saved', 4)
  c = f.command()
  expect(c.items.get('saved')!.revision).toBe(2)
  expect(c.captured.get('live')).toBe(c.items.get('saved'))
})

function statusColumns(db: Database.Database, itemId: string) {
  return db
    .prepare(`SELECT message_role, command_entry, lifecycle_state, assistant_prose, turn_scope_kind
      FROM journal_proj_items WHERE entry_key=?`)
    .get(JSON.stringify(itemId))
}

function row(itemId: string, body: AgentJournalItemBody, turnScope?: AgentJournalTurnScope) {
  return { itemId, revision: 0, sequence: 2, observedAt: 100, body, turnScope }
}

it('derives row-local status columns from typed and legacy bodies', () => {
  const f = fixture()
  const c = f.command()
  const rows = [
    row('command', { kind: 'message', role: 'assistant', blocks: [], command: { name: '' } }),
    row(
      'visual',
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: '::orca-visual{file="usage.html" title="Usage"}' }]
      },
      { kind: 'thread' }
    ),
    row(
      'legacy',
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 't', state: 'running' } },
      {
        kind: 'unknown'
      }
    ),
    row(
      'turn',
      { kind: 'turn', turnId: 't', state: 'completed' },
      { kind: 'turn', turnItemId: 'turn' }
    ),
    row('approval', {
      kind: 'approval',
      title: 'Run?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }),
    row('diff', {
      kind: 'diff',
      path: 'a.ts',
      patch: { head: '', byteLength: 0, digest: '', truncated: false }
    })
  ]
  for (const value of rows) {
    c.items.set(value.itemId, value)
  }
  c.items.set('prose', item('prose', 'Done'))
  c.context.flush()
  expect(
    rows.concat(row('prose', item('prose', '').body)).map((r) => statusColumns(f.db, r.itemId))
  ).toEqual([
    {
      message_role: 'assistant',
      command_entry: 1,
      lifecycle_state: null,
      assistant_prose: 0,
      turn_scope_kind: null
    },
    {
      message_role: 'assistant',
      command_entry: 0,
      lifecycle_state: null,
      assistant_prose: 0,
      turn_scope_kind: 'thread'
    },
    {
      message_role: null,
      command_entry: 0,
      lifecycle_state: 'running',
      assistant_prose: 0,
      turn_scope_kind: 'unknown'
    },
    {
      message_role: null,
      command_entry: 0,
      lifecycle_state: 'completed',
      assistant_prose: 0,
      turn_scope_kind: 'turn'
    },
    {
      message_role: null,
      command_entry: 0,
      lifecycle_state: 'pending',
      assistant_prose: 0,
      turn_scope_kind: null
    },
    {
      message_role: null,
      command_entry: 0,
      lifecycle_state: null,
      assistant_prose: 0,
      turn_scope_kind: null
    },
    {
      message_role: 'assistant',
      command_entry: 0,
      lifecycle_state: null,
      assistant_prose: 1,
      turn_scope_kind: null
    }
  ])
})

it('rewrites status columns only for the current incarnation and rolls them back with it', () => {
  const f = fixture()
  const turn = (state: 'running' | 'completed', revision: number) => ({
    ...row('turn', { kind: 'turn', turnId: 't', state }),
    revision
  })
  let c = f.command()
  c.items.set('turn', turn('running', 0))
  f.save(c, 'turn', 2)
  c = f.command()
  c.captured.set('old', c.items.get('turn')!)
  c.items.set('turn', turn('completed', 1))
  f.save(c, 'turn', 3)
  c = f.command()
  Object.assign(c.captured.get('old')!.body, { state: 'interrupted' })
  c.context.flush()
  expect(statusColumns(f.db, 'turn')).toMatchObject({ lifecycle_state: 'completed' })
  c = f.command()
  c.captured.set('live', c.items.get('turn')!)
  c.context.flush()
  c = f.command()
  Object.assign(c.captured.get('live')!.body, { state: 'unverifiable' })
  f.save(c, 'turn', 4)
  expect(statusColumns(f.db, 'turn')).toMatchObject({ lifecycle_state: 'unverifiable' })
  f.db.exec('SAVEPOINT command')
  c = f.command()
  c.items.set('turn', item('turn', 'replaced', 2))
  f.save(c, 'turn', 5)
  expect(statusColumns(f.db, 'turn')).toMatchObject({
    message_role: 'assistant',
    lifecycle_state: null
  })
  f.db.exec('ROLLBACK TO command; RELEASE command')
  expect(statusColumns(f.db, 'turn')).toEqual({
    message_role: null,
    command_entry: 0,
    lifecycle_state: 'unverifiable',
    assistant_prose: 0,
    turn_scope_kind: null
  })
})
