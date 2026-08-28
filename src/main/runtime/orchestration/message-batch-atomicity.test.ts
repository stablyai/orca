import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

type MessageMutation =
  | 'markAsRead'
  | 'markAsDelivered'
  | 'markAsUndelivered'
  | 'markAsReadAndDelivered'

const messageIds = Array.from(
  { length: 501 },
  (_, index) => `m${index.toString().padStart(3, '0')}`
)

function seedMessages(sqlite: Database.Database): void {
  sqlite.exec(`
    WITH RECURSIVE ids(value) AS (
      VALUES(0)
      UNION ALL SELECT value + 1 FROM ids WHERE value < 500
    )
    INSERT INTO messages (id, from_handle, to_handle, subject)
    SELECT printf('m%03d', value), 'sender', 'recipient', 'subject' FROM ids;
  `)
}

function rejectLastMessageUpdate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TRIGGER reject_last_message_update
    BEFORE UPDATE ON messages WHEN OLD.id = 'm500'
    BEGIN
      SELECT RAISE(ABORT, 'blocked');
    END;
  `)
}

describe('message batch atomicity', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it.each<{
    method: MessageMutation
    setup?: string
    changedCountSql: string
  }>([
    { method: 'markAsRead', changedCountSql: 'SELECT COUNT(*) count FROM messages WHERE read = 1' },
    {
      method: 'markAsDelivered',
      changedCountSql: 'SELECT COUNT(*) count FROM messages WHERE delivered_at IS NOT NULL'
    },
    {
      method: 'markAsUndelivered',
      setup: "UPDATE messages SET delivered_at = datetime('now')",
      changedCountSql: 'SELECT COUNT(*) count FROM messages WHERE delivered_at IS NULL'
    },
    {
      method: 'markAsReadAndDelivered',
      changedCountSql:
        'SELECT COUNT(*) count FROM messages WHERE read = 1 OR delivered_at IS NOT NULL'
    }
  ])('rolls back $method when a later batch fails', ({ method, setup, changedCountSql }) => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    seedMessages(sqlite)
    if (setup) {
      sqlite.exec(setup)
    }
    rejectLastMessageUpdate(sqlite)

    expect(() => db?.[method](messageIds)).toThrow('blocked')

    const changed = sqlite.prepare(changedCountSql).get() as { count: number }
    expect(changed.count).toBe(0)
  })

  it('preserves an outer transaction when an inner batch rolls back', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    seedMessages(sqlite)
    rejectLastMessageUpdate(sqlite)
    sqlite.exec('BEGIN IMMEDIATE')
    sqlite.prepare("UPDATE messages SET subject = 'outer change' WHERE id = 'm000'").run()

    expect(() => db?.markAsRead(messageIds)).toThrow('blocked')
    sqlite.exec('COMMIT')

    const first = sqlite.prepare("SELECT subject, read FROM messages WHERE id = 'm000'").get() as {
      subject: string
      read: number
    }
    expect(first).toEqual({ subject: 'outer change', read: 0 })
  })

  it('preserves an outer transaction when a message insert batch rolls back', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite.exec(`
      CREATE TRIGGER reject_second_message_insert
      BEFORE INSERT ON messages WHEN NEW.id = 'inner_second'
      BEGIN
        SELECT RAISE(ABORT, 'blocked');
      END;
      BEGIN IMMEDIATE;
      INSERT INTO messages (id, from_handle, to_handle, subject)
      VALUES ('outer', 'sender', 'recipient', 'outer change');
    `)

    expect(() =>
      db?.insertMessages([
        { id: 'inner_first', from: 'sender', to: 'recipient', subject: 'first' },
        { id: 'inner_second', from: 'sender', to: 'recipient', subject: 'second' }
      ])
    ).toThrow('blocked')
    sqlite.exec('COMMIT')

    expect(
      sqlite
        .prepare("SELECT id FROM messages WHERE id IN ('outer', 'inner_first') ORDER BY id")
        .all()
    ).toEqual([{ id: 'outer' }])
  })
})
