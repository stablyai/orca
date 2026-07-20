import type SyncDatabase from '../sqlite/sync-database'

export type WebChatSource = 'CHATGPT' | 'CLAUDE' | 'GEMINI'

export type WebConversation = {
  source: WebChatSource
  externalId: string
  title: string | null
  createdAt: string | null
  updatedAt: string | null
  messages: { role: 'USER' | 'AI'; idx: number; text: string | null; createdAt: string | null }[]
}

export function upsertWebConversation(
  db: SyncDatabase,
  conv: WebConversation,
  syncedAt: string
): string {
  const id = `${conv.source}/${conv.externalId}`
  // Why: SyncDatabase has no transaction() wrapper, and the message rows are
  // deleted before they are reinserted — without this a mid-write failure would
  // leave the conversation updated but its messages gone or half-replaced.
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO conversations (id, source, external_id, title, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, created_at = excluded.created_at,
         updated_at = excluded.updated_at, synced_at = excluded.synced_at`
    ).run(id, conv.source, conv.externalId, conv.title, conv.createdAt, conv.updatedAt, syncedAt)
    // Why: 메시지는 멱등하게 전량 교체(대화가 웹에서 이어졌을 수 있음).
    db.prepare('DELETE FROM messages WHERE conv_id = ?').run(id)
    const insert = db.prepare(
      'INSERT INTO messages (id, conv_id, role, idx, text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const m of conv.messages) {
      insert.run(`${id}#${m.idx}`, id, m.role, m.idx, m.text, m.createdAt)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return id
}

// Why: the native host asks which conversations it has already stored so the
// extension can skip re-fetching them (delta sync).
export function listIngestedExternalIds(db: SyncDatabase, source: WebChatSource): string[] {
  const rows = db
    .prepare('SELECT external_id FROM conversations WHERE source = ? ORDER BY external_id')
    .all(source) as { external_id: string }[]
  return rows.map((row) => row.external_id)
}
