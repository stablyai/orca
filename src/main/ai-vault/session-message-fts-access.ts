import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { Database } from 'fts5-sql-bundle'
import { aiVaultSessionRgTargets } from '../../shared/ai-vault-session-rg-args'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { selectSqlJsAll } from './session-message-fts-select'

export const MESSAGE_FTS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_mtime INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
`

export function ensureMessageFtsSchema(db: Database): void {
  const columns = selectSqlJsAll(db, 'PRAGMA table_info(messages)', []) as { name: string }[]
  if (columns.length > 0 && !columns.some((column) => column.name === 'file_path')) {
    db.run('DROP TABLE IF EXISTS messages_fts')
    db.run('DROP TABLE IF EXISTS messages')
    db.run('DROP TABLE IF EXISTS sessions')
  }
  db.run(MESSAGE_FTS_DDL)
}

export async function readableAiVaultSessionTargets(session: {
  agent: string
  filePath: string
}): Promise<string[]> {
  const readable: string[] = []
  for (const target of aiVaultSessionRgTargets(session)) {
    try {
      const info = await stat(target)
      if (!info.isFile()) {
        continue
      }
      await access(target, fsConstants.R_OK)
      readable.push(target)
    } catch {
      // Skip a missing sibling (e.g. grok chat_history) without failing the rest.
    }
  }
  return readable
}

export async function sessionHasLocalTranscript(session: AiVaultSession): Promise<boolean> {
  const targets = aiVaultSessionRgTargets(session)
  if (targets.length === 0) {
    return true
  }
  return (await readableAiVaultSessionTargets(session)).length > 0
}

export async function readFileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return 0
  }
}
