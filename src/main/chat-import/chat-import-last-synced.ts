import type SyncDatabase from '../sqlite/sync-database'
import type { WebChatSource } from './chat-import-store'

const SOURCES: WebChatSource[] = ['CHATGPT', 'CLAUDE', 'GEMINI']

export function lastSyncedBySource(db: SyncDatabase): Record<WebChatSource, string | null> {
  const rows = db
    .prepare('SELECT source, MAX(synced_at) AS last FROM conversations GROUP BY source')
    .all() as { source: string; last: string | null }[]
  const bySource = new Map(rows.map((r) => [r.source, r.last]))
  return Object.fromEntries(SOURCES.map((s) => [s, bySource.get(s) ?? null])) as Record<
    WebChatSource,
    string | null
  >
}
