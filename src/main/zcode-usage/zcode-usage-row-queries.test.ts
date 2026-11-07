import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { selectZcodeUsageRows } from './zcode-usage-row-queries'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function database(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'orca-zcode-schema-'))
  roots.push(root)
  return new Database(join(root, 'db.sqlite'))
}

describe('selectZcodeUsageRows', () => {
  it('keeps rows whose optional token columns are null', () => {
    const db = database()
    try {
      db.exec(`
        CREATE TABLE model_usage (
          session_id TEXT,
          started_at INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER
        );
        INSERT INTO model_usage VALUES ('session-1', 1000, 5000, 20, NULL, NULL, NULL);
      `)

      expect(selectZcodeUsageRows(db)).toMatchObject([
        { session_id: 'session-1', input_tokens: 5000, output_tokens: 20 }
      ])
    } finally {
      db.close()
    }
  })

  it('reads an older schema without started_at or session.directory', () => {
    const db = database()
    try {
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE model_usage (session_id TEXT, input_tokens INTEGER, output_tokens INTEGER);
        INSERT INTO session VALUES ('session-1');
        INSERT INTO model_usage VALUES ('session-1', 2, 3);
      `)

      expect(selectZcodeUsageRows(db)).toMatchObject([
        { session_id: 'session-1', directory: null, started_at: null }
      ])
    } finally {
      db.close()
    }
  })
})
