import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../main/sqlite/sync-database'

export function seedHermesSessionRun(home: string): void {
  mkdirSync(home, { recursive: true })
  const db = new Database(join(home, 'state.db'))
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, started_at REAL, ended_at REAL,
        end_reason TEXT, model TEXT, message_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
        tool_name TEXT, reasoning TEXT, reasoning_content TEXT, timestamp REAL
      );
      INSERT INTO sessions VALUES (
        'cron_job-1_20260701_100000', 'Scheduled fixture', 1782900000, 1782900060,
        'completed', 'fixture-model', 1, 10, 20, 0.01
      );
      INSERT INTO messages VALUES (
        1, 'cron_job-1_20260701_100000', 'assistant', 'Database-backed run output',
        NULL, NULL, NULL, 1782900001
      );
    `)
  } finally {
    db.close()
  }
}
