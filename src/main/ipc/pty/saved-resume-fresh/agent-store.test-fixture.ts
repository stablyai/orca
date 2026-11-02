import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import SyncDatabase from '../../../sqlite/sync-database'

// First records of real sessions each CLI wrote, trimmed after their identity fields.
export const CODEX_ID = '019f1abc-b2cf-7571-bf39-6127d4ebaba2'
export const CODEX_ROLLOUT = `rollout-2026-06-30T15-53-22-${CODEX_ID}.jsonl`
export const CODEX_HEADER =
  '{"timestamp":"2026-06-30T22:53:22.213Z","type":"session_meta","payload":{"session_id":"019f1abc-b2cf-7571-bf39-6127d4ebaba2","id":"019f1abc-b2cf-7571-bf39-6127d4ebaba2","timestamp":"2026-06-30T22:53:22.023Z","cwd":"/private/tmp/stream-codex","originator":"codex_exec","cli_version":"0.142.2"}}\n'

export const CLAUDE_ID = '21f5e73a-4a3a-42ac-bd73-bc8d88256d65'
export const CLAUDE_HEADER =
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-06-30T22:48:46.318Z","sessionId":"21f5e73a-4a3a-42ac-bd73-bc8d88256d65","content":"Explain what main.swift does."}\n{"type":"queue-operation","operation":"dequeue","timestamp":"2026-06-30T22:48:46.319Z","sessionId":"21f5e73a-4a3a-42ac-bd73-bc8d88256d65"}\n'
/** An older transcript's first record carries no session id. */
export const CLAUDE_SUMMARY_HEADER =
  '{"type":"summary","summary":"Refactor the parser","leafUuid":"6c1f4e0a-8a1b-4d2a-9c3e-5b7d9e1f2a3b"}\n'

export const PI_ID = '019f1abe-902b-7b79-8a12-c0169ed3e187'
export const PI_FILE = `2026-06-30T22-55-24-203Z_${PI_ID}.jsonl`
export const PI_HEADER =
  '{"type":"session","version":3,"id":"019f1abe-902b-7b79-8a12-c0169ed3e187","timestamp":"2026-06-30T22:55:24.203Z","cwd":"/private/tmp/stream-pi"}\n'

export const OPENCODE_ID = 'ses_0e5411393ffeCDprItbIm19S5J'

export function writeStoreFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** OpenCode's session table in the dialect a channel writes; v1 `session`, v2 `session_v2`. */
export function writeOpenCodeDatabase(
  path: string,
  table: 'session' | 'session_v2',
  ids: string[]
) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new SyncDatabase(path)
  try {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, directory TEXT, title TEXT)`)
    for (const id of ids) {
      db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(id, '/private/tmp/stream', 'Explain')
    }
  } finally {
    db.close()
  }
}

export const codexSessionsDay = (home: string) => join(home, 'sessions', '2026', '06', '30')
