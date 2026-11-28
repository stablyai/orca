import type Database from '../sqlite/sync-database'

export function initializeFeishuInbox(db: Database.Database): void {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS bindings(account TEXT PRIMARY KEY, scope TEXT NOT NULL,bot TEXT NOT NULL,profile TEXT NOT NULL,app TEXT NOT NULL UNIQUE,owner TEXT,chat TEXT,pairedAt INTEGER,UNIQUE(scope,bot));
    CREATE TABLE IF NOT EXISTS inbox(account TEXT NOT NULL REFERENCES bindings(account) ON DELETE CASCADE,mid TEXT NOT NULL,event TEXT NOT NULL,body TEXT,first_post INTEGER,review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),UNIQUE(account,event));
    CREATE INDEX IF NOT EXISTS pending_feishu_messages ON inbox(account) WHERE body IS NOT NULL AND review=0;
    CREATE TABLE IF NOT EXISTS reply_files(account TEXT NOT NULL,mid TEXT NOT NULL,name TEXT NOT NULL,bytes BLOB,sha256 TEXT,file_key TEXT,posted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account,mid),FOREIGN KEY(account,mid) REFERENCES inbox(account,mid) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS review_feishu_messages ON inbox(account) WHERE review=1;`)
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
  if (!columns.some((c) => c.name === 'group_route')) {
    db.exec('ALTER TABLE inbox ADD COLUMN group_route TEXT')
  }
  if (!columns.some((c) => c.name === 'group_body')) {
    db.exec('ALTER TABLE inbox ADD COLUMN group_body TEXT')
  }
  if (!columns.some((c) => c.name === 'group_key')) {
    db.exec('ALTER TABLE inbox ADD COLUMN group_key TEXT')
  }
  if (
    !db
      .prepare('PRAGMA table_info(bindings)')
      .all()
      .some((c) => c.name === 'group_policy')
  ) {
    db.exec('ALTER TABLE bindings ADD COLUMN group_policy TEXT')
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS pending_feishu_topics ON inbox(account,group_key) WHERE group_key IS NOT NULL AND reply_done=0'
  )
}
