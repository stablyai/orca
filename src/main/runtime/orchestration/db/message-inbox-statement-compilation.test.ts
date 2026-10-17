import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

const databases: OrchestrationDb[] = []
const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openDatabase(path = ':memory:'): OrchestrationDb {
  const db = new OrchestrationDb(path)
  databases.push(db)
  return db
}

function isNativeDatabase(value: unknown): value is { prepare(sql: string): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'prepare' in value &&
    typeof value.prepare === 'function'
  )
}

function trackCompilations(db: OrchestrationDb): string[] {
  const wrapper: unknown = db.db
  if (
    typeof wrapper !== 'object' ||
    wrapper === null ||
    !('db' in wrapper) ||
    !isNativeDatabase(wrapper.db)
  ) {
    throw new Error('Missing native SQLite database')
  }
  const native = wrapper.db
  const original = native.prepare.bind(native)
  const compiled: string[] = []
  vi.spyOn(native, 'prepare').mockImplementation((sql) => {
    compiled.push(sql)
    return original(sql)
  })
  return compiled
}

function seedMessage(db: OrchestrationDb, to = 'term_b') {
  return db.insertMessage({
    runId: 'run_legacy_local',
    from: 'term_a',
    to,
    subject: 'message',
    body: 'body',
    threadId: 'thread',
    payload: '{"key":"value"}',
    senderPaneKey: 'tab_a:leaf_a'
  })
}

describe('message inbox statement compilation', () => {
  it('compiles each repeated unread query shape once and keeps parameters independent', () => {
    const db = openDatabase()
    const message = seedMessage(db)
    const other = seedMessage(db, 'term_c')
    const compiled = trackCompilations(db)
    const read = () => [
      db.getUnreadMessages('term_b'),
      db.getUnreadMessages('term_c', ['status']),
      db.getUndeliveredUnreadMessages('term_b'),
      db.getUndeliveredUnreadMessages('term_c', ['status'], {
        excludeTypes: ['heartbeat'],
        limit: 3
      }),
      db.getMessageById(message.id),
      db.getMessageById(other.id)
    ]
    const first = read()
    const firstCompilations = [...compiled]
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(read()).toEqual(first)
      expect(db.getUnreadMessages('term_absent')).toEqual([])
      expect(db.getMessageById('msg_absent')).toBeUndefined()
    }
    expect(firstCompilations.length).toBeGreaterThan(0)
    expect(compiled).toEqual(firstCompilations)
    expect(compiled.filter((sql) => sql.includes('SELECT *'))).toEqual([])
  })

  it('returns every stored field with unchanged ordering, filtering, and UTC timestamps', () => {
    const db = openDatabase()
    const first = seedMessage(db)
    const delivered = seedMessage(db)
    const pending = seedMessage(db)
    const audit = seedMessage(db)
    db.markAsDelivered([delivered.id])
    db.db.prepare("UPDATE messages SET delivery_contract = 'audit_only' WHERE id = ?").run(audit.id)
    db.db.prepare('UPDATE messages SET pointer_enter_pending = 1 WHERE id = ?').run(pending.id)
    const raw = db.db.prepare('SELECT * FROM messages WHERE id = ?').get(first.id)
    if (!raw || typeof raw.created_at !== 'string') {
      throw new Error('Missing seeded message')
    }
    expect(db.getMessageById(first.id)).toEqual({
      ...raw,
      created_at: `${raw.created_at.replace(' ', 'T')}Z`
    })
    expect(db.getUnreadMessages('term_b').map((row) => row.id)).toEqual([
      first.id,
      delivered.id,
      pending.id
    ])
    expect(db.getUndeliveredUnreadMessages('term_b').map((row) => row.id)).toEqual([first.id])
    expect(db.getUndeliveredUnreadMessages('term_b', ['status'], { limit: 0.5 })).toHaveLength(1)
    expect(
      db.getUndeliveredUnreadMessages('term_b', undefined, { excludeTypes: ['status'] })
    ).toEqual([])
    expect(db.getMessageById(first.id)?.created_at).toMatch(/T.*Z$/)
    db.markAsRead([first.id])
    expect(db.getUnreadMessages('term_b').map((row) => row.id)).toEqual([delivered.id, pending.id])
  })

  it('sees another connection writes after warming a statement and recompiles after local DDL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-message-compilation-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const reader = openDatabase(path)
    const writer = openDatabase(path)
    expect(reader.getUnreadMessages('term_b')).toEqual([])
    const message = seedMessage(writer)
    expect(reader.getUnreadMessages('term_b').map((row) => row.id)).toEqual([message.id])
    writer.markAsRead([message.id])
    expect(reader.getUnreadMessages('term_b')).toEqual([])
    const compiled = trackCompilations(reader)
    reader.db.exec('CREATE INDEX message_compilation_test ON messages(subject)')
    expect(reader.getUnreadMessages('term_b')).toEqual([])
    expect(compiled).toHaveLength(1)
    expect(reader.getUnreadMessages('term_b')).toEqual([])
    expect(compiled).toHaveLength(1)
  })
})
