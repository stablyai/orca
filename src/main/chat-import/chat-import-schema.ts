import type SyncDatabase from '../sqlite/sync-database'

// Why: 웹 대화 전용 최소 스키마. 아카이브 앱의 "graph" 네이밍/로컬 전용 컬럼
// (git/cwd/token)은 제외한다. 1b(네이티브 호스트)가 쓰고, AI Vault 파서가 읽는다.
export function initChatImportSchema(db: SyncDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      synced_at TEXT NOT NULL,
      UNIQUE(source, external_id));
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT,
      created_at TEXT);
    PRAGMA user_version = 1;
  `)
}
