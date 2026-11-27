import type Database from '../sqlite/sync-database'
export function migrateFeishuInbox(db: Database.Database): void {
  if (
    !db
      .prepare('PRAGMA table_info(reply_files)')
      .all()
      .some((c) => c.name === 'sha256')
  ) {
    db.exec('ALTER TABLE reply_files ADD COLUMN sha256 TEXT')
  }
  if (
    !db
      .prepare('PRAGMA table_info(bindings)')
      .all()
      .some((c) => c.name === 'sealed_secret')
  ) {
    db.exec('ALTER TABLE bindings ADD COLUMN sealed_secret TEXT')
  }
  const columns = db.prepare('PRAGMA table_info(inbox)').all()
  if (!columns.some((c) => c.name === 'reply_done')) {
    db.exec('ALTER TABLE inbox ADD COLUMN reply_done INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.some((c) => c.name === 'progress')) {
    db.exec('ALTER TABLE inbox ADD COLUMN progress INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'")
  }
  if (!columns.some((c) => c.name === 'stored_path')) {
    db.exec('ALTER TABLE inbox ADD COLUMN stored_path TEXT')
  }
}
