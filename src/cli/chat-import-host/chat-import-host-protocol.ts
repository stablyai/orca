import type SyncDatabase from '../../main/sqlite/sync-database'
import {
  listIngestedExternalIds,
  upsertWebConversation,
  type WebChatSource,
  type WebConversation
} from '../../main/chat-import/chat-import-store'

export type ChatImportHostResponse =
  | { type: 'INGESTED_IDS'; externalIds: string[] }
  | { type: 'INGEST'; ok: true; id: string }
  | { type: 'ERROR'; error: string }

const SOURCES: readonly WebChatSource[] = ['CHATGPT', 'CLAUDE', 'GEMINI']

function isSource(value: unknown): value is WebChatSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

// Why: the conv arrives as untrusted JSON from the extension; validate the
// shape before it reaches SQLite. Only M1 fields (text, no blocks/attachments).
function parseConversation(value: unknown): WebConversation | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const c = value as Record<string, unknown>
  if (!isSource(c.source) || typeof c.externalId !== 'string' || !Array.isArray(c.messages)) {
    return null
  }
  const messages: WebConversation['messages'] = []
  for (const raw of c.messages) {
    if (!raw || typeof raw !== 'object') {
      return null
    }
    const m = raw as Record<string, unknown>
    if ((m.role !== 'USER' && m.role !== 'AI') || typeof m.idx !== 'number') {
      return null
    }
    messages.push({
      role: m.role,
      idx: m.idx,
      text: typeof m.text === 'string' ? m.text : null,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : null
    })
  }
  return {
    source: c.source,
    externalId: c.externalId,
    title: typeof c.title === 'string' ? c.title : null,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : null,
    messages
  }
}

export function processChatImportHostMessage(
  db: SyncDatabase,
  rawJson: string,
  syncedAt: string
): ChatImportHostResponse {
  let message: unknown
  try {
    message = JSON.parse(rawJson)
  } catch {
    return { type: 'ERROR', error: 'invalid JSON' }
  }
  if (!message || typeof message !== 'object') {
    return { type: 'ERROR', error: 'not an object' }
  }
  const request = message as Record<string, unknown>
  try {
    if (request.type === 'INGESTED_IDS') {
      if (!isSource(request.source)) {
        return { type: 'ERROR', error: 'bad source' }
      }
      return { type: 'INGESTED_IDS', externalIds: listIngestedExternalIds(db, request.source) }
    }
    if (request.type === 'INGEST') {
      const conv = parseConversation(request.conv)
      if (!conv) {
        return { type: 'ERROR', error: 'bad conversation' }
      }
      return { type: 'INGEST', ok: true, id: upsertWebConversation(db, conv, syncedAt) }
    }
    return { type: 'ERROR', error: `unknown type: ${String(request.type)}` }
  } catch (err) {
    return { type: 'ERROR', error: err instanceof Error ? err.message : String(err) }
  }
}
