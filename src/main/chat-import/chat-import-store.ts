import type SyncDatabase from '../sqlite/sync-database'
import type { WebChatAgent } from '../../shared/ai-vault-types'

export type WebChatSource = 'CHATGPT' | 'CLAUDE' | 'GEMINI'

// Why: single source of truth for the stored-source ↔ vault-agent correspondence
// (was copy-pasted across the two web-chat scanners and the transcript reader).
// A new web-chat source now needs editing one map, type-checked in both directions.
export const SOURCE_TO_AGENT: Record<WebChatSource, WebChatAgent> = {
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude-web',
  GEMINI: 'gemini-web'
}

export const AGENT_TO_SOURCE: Record<WebChatAgent, WebChatSource> = {
  chatgpt: 'CHATGPT',
  'claude-web': 'CLAUDE',
  'gemini-web': 'GEMINI'
}

export type WebAttachment = {
  kind: 'image' | 'file'
  mimeType: string
  fileName: string
  size: number
  width: number | null
  height: number | null
  hash: string
}

export type WebConversation = {
  source: WebChatSource
  externalId: string
  title: string | null
  createdAt: string | null
  updatedAt: string | null
  messages: {
    role: 'USER' | 'AI'
    idx: number
    text: string | null
    createdAt: string | null
    attachments?: WebAttachment[]
  }[]
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
  // Why: same delete-all-then-reinsert as messages above — keeps re-sync idempotent.
  db.prepare('DELETE FROM attachments WHERE conv_id = ?').run(id)
  const insertAttachment = db.prepare(
    `INSERT INTO attachments (conv_id, msg_idx, att_idx, kind, mime, file_name, size, hash, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const m of conv.messages) {
    m.attachments?.forEach((att, attIdx) => {
      if (!att.hash) {
        return // Why: 해시 없는 첨부는 blob store에서 조회 불가 — 저장해도 못 씀.
      }
      insertAttachment.run(
        id,
        m.idx,
        attIdx,
        att.kind,
        att.mimeType,
        att.fileName,
        att.size,
        att.hash,
        att.width,
        att.height
      )
    })
  }
  return id
}

// Why: reader-side lookup (AI Vault parser) resolves a message's attachments
// by (convId, msgIdx) to fetch bytes from the blob store via hash.
export function listMessageAttachments(
  db: SyncDatabase,
  convId: string,
  msgIdx: number
): WebAttachment[] {
  const rows = db
    .prepare(
      `SELECT kind, mime, file_name, size, hash, width, height FROM attachments
       WHERE conv_id = ? AND msg_idx = ? ORDER BY att_idx`
    )
    .all(convId, msgIdx) as {
    kind: string
    mime: string | null
    file_name: string | null
    size: number | null
    hash: string
    width: number | null
    height: number | null
  }[]
  return rows.map((r) => ({
    kind: r.kind as WebAttachment['kind'],
    mimeType: r.mime ?? '',
    fileName: r.file_name ?? '',
    size: r.size ?? 0,
    width: r.width,
    height: r.height,
    hash: r.hash
  }))
}

// Why: storage GC needs the set of blob hashes still referenced by an
// attachment row so it can reclaim the rest as orphans.
export function listReferencedBlobHashes(db: SyncDatabase): Set<string> {
  const rows = db.prepare('SELECT DISTINCT hash FROM attachments').all() as { hash: string }[]
  return new Set(rows.map((r) => r.hash))
}

// Why: the native host asks which conversations it has already stored so the
// extension can skip re-fetching them (delta sync).
export function listIngestedExternalIds(db: SyncDatabase, source: WebChatSource): string[] {
  const rows = db
    .prepare('SELECT external_id FROM conversations WHERE source = ? ORDER BY external_id')
    .all(source) as { external_id: string }[]
  return rows.map((row) => row.external_id)
}
