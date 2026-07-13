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
  return id
}
