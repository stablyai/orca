import type SyncDatabase from '../sqlite/sync-database'

export function initializeEditorRecoverySchema(db: SyncDatabase): void {
  const version = db.pragma('user_version', { simple: true })
  if (version !== 0 && version !== 1 && version !== 2) {
    throw new Error('This recovery journal requires a newer application version')
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  if (version === 2) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS editor_drafts (
        id TEXT PRIMARY KEY,
        resource_key TEXT NOT NULL,
        metadata TEXT NOT NULL,
        content TEXT,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_length INTEGER,
        patch_count INTEGER NOT NULL DEFAULT 0,
        patch_bytes INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS editor_drafts_resource ON editor_drafts(resource_key, state);
      CREATE TABLE IF NOT EXISTS editor_draft_bodies (
        id TEXT PRIMARY KEY REFERENCES editor_drafts(id),
        content TEXT NOT NULL,
        revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS editor_draft_patches (
        id TEXT NOT NULL REFERENCES editor_drafts(id),
        revision INTEGER NOT NULL,
        base_length INTEGER NOT NULL,
        start INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        inserted TEXT NOT NULL,
        byte_length_delta INTEGER NOT NULL,
        PRIMARY KEY (id, revision)
      ) STRICT;
    `)
    const columns = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info('editor_drafts')")
        .all()
        .map((row) => row.name)
    )
    for (const [column, definition] of [
      ['content_length', 'INTEGER'],
      ['patch_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['patch_bytes', 'INTEGER NOT NULL DEFAULT 0']
    ]) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE editor_drafts ADD COLUMN ${column} ${definition}`)
      }
    }
    db.pragma('user_version = 2')
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}
