import type Database from '../sqlite/sync-database'

// OpenCode 1.17.x DB shape used by the SQLite scanner suites: the schema plus
// row builders for `session`, `message` and `part`. Shared so the discovery,
// parser and search-freshness tests all exercise one fixture definition.

/** Full 1.17.x schema, including the columns the scanner treats as optional. */
export function applyOpenCodeSqliteSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT,
      icon_url_override TEXT
    );
  `)
}

/** Only the columns the list reader requires, for the older-schema paths. */
export function applyMinimalOpenCodeSqliteSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );`)
}

export function insertOpenCodeSession(
  db: Database.Database,
  args: {
    id: string
    title?: string
    directory?: string
    timeCreated: number
    timeUpdated: number
    parentId?: string | null
    timeArchived?: number | null
    model?: string | null
    agent?: string | null
    tokensInput?: number
    tokensOutput?: number
    tokensReasoning?: number
    tokensCacheRead?: number
    cost?: number
  }
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, time_archived, model, agent, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, 'proj-1', ?, ?, ?, ?, '1.0.0',
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, 0)`
  ).run(
    args.id,
    args.parentId ?? null,
    `slug-${args.id}`,
    args.directory ?? '/tmp/opencode',
    args.title ?? 'OpenCode title',
    args.timeCreated,
    args.timeUpdated,
    args.timeArchived ?? null,
    args.model ?? JSON.stringify({ id: 'glm-5.2', providerID: 'zai-coding-plan' }),
    args.agent ?? 'build',
    args.cost ?? 0,
    args.tokensInput ?? 100,
    args.tokensOutput ?? 40,
    args.tokensReasoning ?? 10,
    args.tokensCacheRead ?? 5
  )
}

export function insertOpenCodeMessage(
  db: Database.Database,
  args: {
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    timeCreated: number
    summaryTitle?: string | null
    summaryBody?: string | null
  }
): void {
  const data = JSON.stringify({
    role: args.role,
    time: { created: args.timeCreated },
    agent: 'build',
    summary:
      args.summaryTitle || args.summaryBody
        ? { title: args.summaryTitle ?? null, body: args.summaryBody ?? null }
        : undefined
  })
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(args.id, args.sessionId, args.timeCreated, args.timeCreated, data)
}

export function insertOpenCodePart(
  db: Database.Database,
  args: {
    id: string
    messageId: string
    sessionId: string
    timeCreated: number
    type?: 'text' | 'tool' | 'reasoning'
    text?: string
  }
): void {
  const data = JSON.stringify({
    type: args.type ?? 'text',
    text: args.text ?? 'hello world'
  })
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(args.id, args.messageId, args.sessionId, args.timeCreated, args.timeCreated, data)
}

/** Mirrors OpenCode bumping the session row when a message lands. */
export function touchOpenCodeSession(
  db: Database.Database,
  args: { id: string; timeUpdated: number }
): void {
  db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(args.timeUpdated, args.id)
}
