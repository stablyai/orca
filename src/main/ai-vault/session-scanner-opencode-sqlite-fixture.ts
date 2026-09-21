import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

// The OpenCode 1.17.x schema, as the app itself creates it. Written out in full
// rather than trimmed to the columns a reader names, because every read probes
// for its columns and a trimmed fixture would pass a probe the real database
// fails (or the reverse) without the test being able to tell.

const OPENCODE_SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
    time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
    cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    metadata TEXT
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
    icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`

export const OPENCODE_FIXTURE_EPOCH_MS = 1_740_000_000_000

/**
 * One `part` row. A bare string is a text part, which is what most turns are.
 *
 * The tool shape mirrors what OpenCode actually writes: the call's name and id
 * at the top level, and everything about the run nested under `state`.
 */
export type OpenCodeSqliteFixturePart =
  | string
  | { type: 'text' | 'reasoning'; text: string }
  | {
      type: 'tool'
      tool: string
      input?: Record<string, unknown>
      output?: string
      error?: string
    }

export type OpenCodeSqliteFixtureTurn = {
  role: 'user' | 'assistant'
  /** One part row per entry, in the order the session recorded them. */
  parts: readonly OpenCodeSqliteFixturePart[]
}

export type OpenCodeSqliteFixtureSession = {
  id: string
  title?: string
  directory?: string
  turns: readonly OpenCodeSqliteFixtureTurn[]
}

/**
 * Create an OpenCode SQLite database holding `sessions`.
 *
 * Each turn's parts are written as separate `part` rows, which is the shape a
 * reader has to reassemble; a fixture with one part per turn would never
 * exercise it. A session's `time_updated` is its last turn's timestamp, the
 * same stat the real database moves when a session gains a message.
 * @param dbPath - Where to create the database; parent directories are created.
 * @param sessions - The sessions to write, in the order they were created.
 */
export function writeOpenCodeSqliteDatabase(
  dbPath: string,
  sessions: readonly OpenCodeSqliteFixtureSession[]
): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new SyncDatabase(dbPath)
  try {
    if (!tableAlreadyThere(db)) {
      db.exec(OPENCODE_SCHEMA)
      db.prepare(
        `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
         VALUES ('proj-1', '/tmp/opencode', 'proj', ?, ?, '[]')`
      ).run(OPENCODE_FIXTURE_EPOCH_MS, OPENCODE_FIXTURE_EPOCH_MS)
    }
    for (const session of sessions) {
      writeSession(db, session)
    }
  } finally {
    db.close()
  }
}

function tableAlreadyThere(db: SyncDatabase): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session'`).get() !==
    undefined
  )
}

function writeSession(db: SyncDatabase, session: OpenCodeSqliteFixtureSession): void {
  const created = OPENCODE_FIXTURE_EPOCH_MS
  const updated = created + Math.max(1, session.turns.length) * 60_000
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, agent, model, cost, tokens_input, tokens_output,
       tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, 'proj-1', NULL, 'slug-1', ?, ?, '1.0.0', ?, ?, 'build', '{"id":"glm"}',
       0, 1, 1, 0, 0, 0)
     ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`
  ).run(
    session.id,
    session.directory ?? '/tmp/opencode',
    session.title ?? 'OpenCode title',
    created,
    updated
  )
  appendTurns(db, session, created)
}

/** Appends `turns` after whatever the session already holds. */
export function appendTurns(
  db: SyncDatabase,
  session: OpenCodeSqliteFixtureSession,
  startMs: number
): void {
  const insertMessage = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`
  )
  const insertPart = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  session.turns.forEach((turn, turnIndex) => {
    const at = startMs + (turnIndex + 1) * 60_000
    const messageId = `${session.id}-msg-${turnIndex}-${at}`
    insertMessage.run(
      messageId,
      session.id,
      at,
      at,
      JSON.stringify({ role: turn.role, time: { created: at } })
    )
    turn.parts.forEach((part, partIndex) => {
      insertPart.run(
        `${messageId}-part-${partIndex}`,
        messageId,
        session.id,
        at + partIndex,
        at + partIndex,
        JSON.stringify(partData(part, `${messageId}-call-${partIndex}`, at))
      )
    })
  })
}

function partData(
  part: OpenCodeSqliteFixturePart,
  callId: string,
  atMs: number
): Record<string, unknown> {
  if (typeof part === 'string') {
    return { type: 'text', text: part }
  }
  if (part.type !== 'tool') {
    return { type: part.type, text: part.text }
  }
  const failed = typeof part.error === 'string'
  return {
    type: 'tool',
    tool: part.tool,
    callID: callId,
    state: {
      status: failed ? 'error' : 'completed',
      input: part.input ?? {},
      ...(failed ? { error: part.error } : { output: part.output ?? '' }),
      title: part.tool,
      time: { start: atMs, end: atMs + 1 }
    }
  }
}

/**
 * Add one turn to an existing session and move its `time_updated`, the way
 * OpenCode does when a session continues.
 * @param dbPath - The fixture database to append to.
 * @param sessionId - The session to continue.
 * @param turn - The turn to append.
 */
export function appendOpenCodeSqliteTurn(
  dbPath: string,
  sessionId: string,
  turn: OpenCodeSqliteFixtureTurn
): void {
  const db = new SyncDatabase(dbPath)
  try {
    const updated = currentUpdatedMs(db, sessionId)
    appendTurns(db, { id: sessionId, turns: [turn] }, updated)
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(updated + 60_000, sessionId)
  } finally {
    db.close()
  }
}

// Throws rather than falling back to the epoch: a mistyped id would otherwise
// append orphan rows and update nothing, leaving a test asserting over a
// transcript that no session owns.
function currentUpdatedMs(db: SyncDatabase, sessionId: string): number {
  const row = db.prepare('SELECT time_updated FROM session WHERE id = ?').get(sessionId)
  if (row === undefined) {
    throw new Error(`OpenCode fixture has no session ${sessionId} to append to`)
  }
  const updated = Object.values(row)[0]
  if (typeof updated !== 'number') {
    throw new Error(`OpenCode fixture session ${sessionId} has no numeric time_updated`)
  }
  return updated
}
