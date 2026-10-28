import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

// Use complete upstream schemas so column probes match real databases; omit foreign keys
// to construct generations independently.

const PROJECT_TABLE = `
  CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT,
    icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT
  );
`

// OpenCode 1.17.x; frozen after OpenCode 2 migration.
const LEGACY_SESSION_TABLE = `
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
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`

const V2_SESSION_TABLE = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
    path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, metadata TEXT,
    cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    revert TEXT, permission TEXT, agent TEXT, model TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER,
    time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL,
    time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT
  );
`

// Older v2 schemas lack totals and must not erase legacy usage.
const V2_SESSION_TABLE_WITHOUT_TOKENS = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
    path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, metadata TEXT,
    revert TEXT, permission TEXT, agent TEXT, model TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER
  );
`

const SESSION_MESSAGE_TABLE = `
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`

export const OPENCODE_USAGE_FIXTURE_EPOCH_MS = 1_740_000_000_000

export type OpenCodeUsageFixtureSession = {
  id: string
  directory: string
  title?: string
  /** NULL matches v1 rows before migration derives a model. */
  model?: string | null
  cost?: number
  tokensInput?: number
  tokensOutput?: number
  tokensReasoning?: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  timeCreated?: number
  timeUpdated?: number
}

/** Migrated databases retain frozen v1 rows alongside their live v2 copies. */
export type OpenCodeUsageFixtureGeneration = 'v1' | 'migrated' | 'v2-only'

export type OpenCodeUsageFixtureSpec = {
  generation: OpenCodeUsageFixtureGeneration
  /** Ignored for v2-only. */
  legacySessions?: readonly OpenCodeUsageFixtureSession[]
  /** Ignored for v1. */
  v2Sessions?: readonly OpenCodeUsageFixtureSession[]
  /** Omit v2 totals; ignored for v1. */
  v2WithoutTokenColumns?: boolean
  worktree?: string
}

const SESSION_IDENTITY_COLUMNS =
  'id, project_id, slug, directory, title, version, time_created, time_updated, agent, model'

const SESSION_USAGE_COLUMNS =
  'cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write'

function insertSession(
  db: SyncDatabase,
  table: 'session' | 'session_v2',
  session: OpenCodeUsageFixtureSession,
  withUsageColumns = true
): void {
  const created = session.timeCreated ?? OPENCODE_USAGE_FIXTURE_EPOCH_MS
  const identity = [
    session.id,
    session.directory,
    session.title ?? 'OpenCode session',
    created,
    session.timeUpdated ?? created + 60_000,
    session.model === undefined
      ? '{"providerID":"anthropic","modelID":"claude-sonnet-4-5"}'
      : session.model
  ]
  const usage = withUsageColumns
    ? [
        session.cost ?? 0,
        session.tokensInput ?? 0,
        session.tokensOutput ?? 0,
        session.tokensReasoning ?? 0,
        session.tokensCacheRead ?? 0,
        session.tokensCacheWrite ?? 0
      ]
    : []
  const columns = withUsageColumns
    ? `${SESSION_IDENTITY_COLUMNS}, ${SESSION_USAGE_COLUMNS}`
    : SESSION_IDENTITY_COLUMNS
  db.prepare(
    `INSERT INTO ${table} (${columns})
     VALUES (?, 'proj-1', 'slug-1', ?, ?, '1.0.0', ?, ?, 'build', ?${', ?'.repeat(usage.length)})`
  ).run(...identity, ...usage)
}

export function writeOpenCodeUsageDatabase(dbPath: string, spec: OpenCodeUsageFixtureSpec): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(PROJECT_TABLE)
    if (spec.generation !== 'v2-only') {
      db.exec(LEGACY_SESSION_TABLE)
    }
    if (spec.generation !== 'v1') {
      db.exec(spec.v2WithoutTokenColumns ? V2_SESSION_TABLE_WITHOUT_TOKENS : V2_SESSION_TABLE)
      db.exec(SESSION_MESSAGE_TABLE)
    }
    db.prepare(
      `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
       VALUES ('proj-1', ?, 'proj', ?, ?, '[]')`
    ).run(
      spec.worktree ?? '/workspace/repo',
      OPENCODE_USAGE_FIXTURE_EPOCH_MS,
      OPENCODE_USAGE_FIXTURE_EPOCH_MS
    )
    if (spec.generation !== 'v2-only') {
      for (const session of spec.legacySessions ?? []) {
        insertSession(db, 'session', session)
      }
    }
    if (spec.generation !== 'v1') {
      for (const session of spec.v2Sessions ?? []) {
        insertSession(db, 'session_v2', session, !spec.v2WithoutTokenColumns)
      }
    }
  } finally {
    db.close()
  }
}
