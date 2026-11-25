// node:sqlite stand-in for a Durable Object's SqlStorage and storage.transaction(async), with the
// object semantics the adapter relies on: BEGIN is refused, a throwing transaction rolls back.
import { DatabaseSync } from 'node:sqlite'
import { ObjectSqliteDatabase, type ObjectSql } from '../src/object-database'

export function nodeObjectSql(db = new DatabaseSync(':memory:')): ObjectSql {
  return {
    exec(text, ...params) {
      if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(text)) { throw new Error('use storage.transaction()') }
      const statement = db.prepare(text)
      const bound = params as never[]
      const rows = statement.columns().length > 0 ? (statement.all(...bound) as Record<string, unknown>[]) : (statement.run(...bound), [])
      return { toArray: () => rows }
    }
  }
}

export function openObjectDatabaseOnNodeSqlite(): ObjectSqliteDatabase {
  const db = new DatabaseSync(':memory:')
  const sql = nodeObjectSql(db)
  let open = false
  const database = new ObjectSqliteDatabase(sql, async (operation) => {
    if (open) { throw new Error('nested storage transaction') }
    open = true
    db.exec('BEGIN')
    try {
      const result = await operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      open = false
    }
  })
  database.applySchema()
  return database
}
