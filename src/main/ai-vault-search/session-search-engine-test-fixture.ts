import type { TranscriptMessageRole } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine, type SessionSearchEngineOptions } from './session-search-engine'
import { cwdKey } from './session-search-file-records'
import { identifierShadowText } from './session-search-identifier-split'
import { SessionSearchStore } from './session-search-store'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'

// Synthetic index rows for the query tests. The write path has its own tests;
// driving it here would make every retrieval assertion depend on the parser.

export type SessionSearchHarness = {
  /** The engine's own connection; the store next to it keeps a second, private one. */
  db: SyncDatabase
  /** A real writer on the same file, so a test can move the index under the engine. */
  store: SessionSearchStore
  engine: SessionSearchEngine
  close: () => Promise<void>
}

export async function openSessionSearchHarness(
  name: string,
  options: SessionSearchEngineOptions = {}
): Promise<SessionSearchHarness> {
  const index: SessionSearchIndexFile = await openSessionSearchIndexFile(name)
  const store = new SessionSearchStore(index.path, (error) => {
    throw error
  })
  // Constructed before any row is planted, because constructing it is what
  // installs the generation triggers the planted rows have to move.
  const engine = new SessionSearchEngine(index.db, options)
  return {
    db: index.db,
    store,
    engine,
    close: async () => {
      store.close()
      await index.close()
    }
  }
}

export type SyntheticSession = {
  id: number
  cwd?: string | null
  text?: string
  /** Rows of `text` to write; one session with many rows is one hit. */
  rows?: number
  role?: TranscriptMessageRole
  /**
   * Written into `tool_text` alongside `text`, which is the one row shape the
   * conversation scope has to exclude while the `all` scope keeps it.
   */
  toolText?: string
  agent?: string
  updatedAt?: string
  messageCount?: number
  /** Written into `files`, which is what makes the source `present`. */
  filePath?: string | null
  /** `sessions.file_path`: the transcript `path:` searches alongside cwd. */
  sessionFilePath?: string
}

/** One session and its message rows, in both FTS tables the way the writer does. */
export function addSyntheticSession(db: SyncDatabase, session: SyntheticSession): void {
  const {
    id,
    cwd = '/repo/app',
    text = 'needle',
    rows = 1,
    role = 'user',
    toolText = '',
    agent = 'claude',
    updatedAt = `2026-09-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    messageCount = rows,
    filePath = `/synthetic/${id}.jsonl`,
    sessionFilePath = `/synthetic/${id}.jsonl`
  } = session
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,title,cwd,cwd_key,updated_at,message_count,resume_command)
     VALUES (?,?,?,?,'fixture',?,?,?,?,'resume')`
  ).run(id, agent, String(id), sessionFilePath, cwd, cwdKey(cwd), updatedAt, messageCount)
  if (filePath !== null) {
    db.prepare(
      'INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES (?,0,1740000000000,?)'
    ).run(filePath, id)
  }
  for (let row = 0; row < rows; row++) {
    const messageId = Number(
      db
        .prepare('INSERT INTO messages(session_row_id,role,ts) VALUES (?,?,?)')
        .run(id, role, updatedAt).lastInsertRowid
    )
    const user = role === 'user' ? text : ''
    const assistant = role === 'assistant' ? text : ''
    const tool = role === 'tool' ? `${text} ${toolText}`.trim() : toolText
    db.prepare(
      'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
    ).run(messageId, user, assistant, tool, identifierShadowText(`${text} ${toolText}`))
  }
}

export function markFork(db: SyncDatabase, ids: readonly number[], hash: string): void {
  for (const id of ids) {
    db.prepare('UPDATE sessions SET content_hash = ?, content_hash_count = 8 WHERE id = ?').run(
      hash,
      id
    )
  }
}
