import type Database from '../../../../sqlite/sync-database'

const CREATE_OBJECT = /^CREATE (TRIGGER|VIEW) (\w+)\b/

/** SQLite stores a trigger or view as its CREATE text, minus the closing semicolon. */
function storedForm(createSql: string): { type: string; name: string; sql: string } {
  const sql = createSql.trim().replace(/;$/, '')
  const match = CREATE_OBJECT.exec(sql)
  if (!match) {
    throw new Error(`Not a CREATE TRIGGER or CREATE VIEW statement: ${sql.slice(0, 60)}`)
  }
  return { type: match[1].toLowerCase(), name: match[2], sql }
}

/**
 * Rebuilds a group of triggers and views only when one's stored SQL differs from `creates`, so an
 * unchanged schema costs one read instead of a write transaction each open. An older build that
 * re-created its own definitions leaves different SQL behind, so this build rebuilds them again.
 * `alongside` runs inside the rebuild transaction, or on its own when nothing changed.
 */
export function refreshSchemaObjects(
  db: Database.Database,
  creates: readonly string[],
  alongside?: string
): void {
  const objects = creates.map(storedForm)
  const stored = new Map(
    db
      .prepare(
        `SELECT type || ':' || name AS object, sql FROM sqlite_master
         WHERE name IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(objects.map(({ name }) => name)))
      .map((row) => [row.object, row.sql])
  )
  if (objects.every(({ type, name, sql }) => stored.get(`${type}:${name}`) === sql)) {
    if (alongside) {
      db.exec(alongside)
    }
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const { type, name, sql } of objects) {
      db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name};\n${sql};`)
    }
    if (alongside) {
      db.exec(alongside)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
