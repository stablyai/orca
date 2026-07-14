import type SyncDatabase from '../../main/sqlite/sync-database'
import {
  listIngestedExternalIds,
  upsertWebConversation,
  type WebAttachment,
  type WebChatSource,
  type WebConversation
} from '../../main/chat-import/chat-import-store'

export type ChatImportHostResponse =
  | { type: 'INGESTED_IDS'; externalIds: string[]; _id?: number | string }
  | { type: 'INGEST'; ok: true; id: string; _id?: number | string }
  | { type: 'STORE_BLOB'; ok: true; hash?: string; size?: number; _id?: number | string }
  | { type: 'PONG'; _id?: number | string }
  | { type: 'ERROR'; error: string; _id?: number | string }

// Why: upload state (chunks-in-flight) is per-CONNECTION, not per-message — the
// caller owns it and injects it here so it can accumulate across STORE_BLOB calls.
export type ChatImportBlobCtx = {
  uploads: Map<string, Buffer[]>
  putBlob: (bytes: Buffer) => string
}

const SOURCES: readonly WebChatSource[] = ['CHATGPT', 'CLAUDE', 'GEMINI']

function isSource(value: unknown): value is WebChatSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

const HEX64_RE = /^[0-9a-f]{64}$/

// Why: attachments arrive as untrusted JSON from the extension — whitelist the
// shape so a malformed or malicious entry can't reach the attachments table.
function parseAttachments(value: unknown): WebAttachment[] {
  const atts: WebAttachment[] = []
  if (!Array.isArray(value)) {
    return atts
  }
  for (const a of value) {
    if (!a || typeof a !== 'object') {
      continue
    }
    const at = a as Record<string, unknown>
    if (
      (at.kind !== 'image' && at.kind !== 'file') ||
      typeof at.hash !== 'string' ||
      !HEX64_RE.test(at.hash)
    ) {
      continue
    }
    atts.push({
      kind: at.kind,
      mimeType: typeof at.mimeType === 'string' ? at.mimeType : '',
      fileName: typeof at.fileName === 'string' ? at.fileName : '',
      size: typeof at.size === 'number' ? at.size : 0,
      width: typeof at.width === 'number' ? at.width : null,
      height: typeof at.height === 'number' ? at.height : null,
      hash: at.hash
    })
  }
  return atts
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
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : null,
      attachments: parseAttachments(m.attachments)
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

// Why: default lets existing callers/tests that don't touch STORE_BLOB omit
// blobCtx; real usage (run-chat-import-host) always injects a real one.
const NULL_BLOB_CTX: ChatImportBlobCtx = { uploads: new Map(), putBlob: () => '' }

export function processChatImportHostMessage(
  db: SyncDatabase,
  rawJson: string,
  syncedAt: string,
  blobCtx: ChatImportBlobCtx = NULL_BLOB_CTX
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
  // Why: the extension correlates each response to its request via _id; echo it back.
  const idField: { _id?: number | string } =
    typeof request._id === 'number' || typeof request._id === 'string' ? { _id: request._id } : {}
  const withId = (r: ChatImportHostResponse): ChatImportHostResponse => ({ ...r, ...idField })
  try {
    if (request.type === 'PING') {
      return withId({ type: 'PONG' })
    }
    if (request.type === 'INGESTED_IDS') {
      if (!isSource(request.source)) {
        return withId({ type: 'ERROR', error: 'bad source' })
      }
      return withId({
        type: 'INGESTED_IDS',
        externalIds: listIngestedExternalIds(db, request.source)
      })
    }
    if (request.type === 'INGEST') {
      const conv = parseConversation(request.conv)
      if (!conv) {
        return withId({ type: 'ERROR', error: 'bad conversation' })
      }
      return withId({ type: 'INGEST', ok: true, id: upsertWebConversation(db, conv, syncedAt) })
    }
    if (request.type === 'STORE_BLOB') {
      const uploadId = String(request.uploadId ?? '')
      const seq = Number(request.seq)
      const total = Number(request.total)
      const data =
        typeof request.data === 'string' ? Buffer.from(request.data, 'base64') : Buffer.alloc(0)
      const chunks = blobCtx.uploads.get(uploadId) ?? []
      chunks[seq] = data
      // Why: caps memory a single upload can hold across chunks before it's flushed to disk.
      const MAX_BLOB_BYTES = 25 * 1024 * 1024
      if (chunks.reduce((n, c) => n + (c?.length ?? 0), 0) > MAX_BLOB_BYTES) {
        blobCtx.uploads.delete(uploadId)
        return withId({ type: 'ERROR', error: 'blob too large' })
      }
      blobCtx.uploads.set(uploadId, chunks)
      if (seq >= total - 1) {
        const bytes = Buffer.concat(chunks)
        blobCtx.uploads.delete(uploadId)
        const hash = blobCtx.putBlob(bytes)
        return withId({ type: 'STORE_BLOB', ok: true, hash, size: bytes.length })
      }
      return withId({ type: 'STORE_BLOB', ok: true }) // 중간 청크 ack
    }
    return withId({ type: 'ERROR', error: `unknown type: ${String(request.type)}` })
  } catch (err) {
    return withId({ type: 'ERROR', error: err instanceof Error ? err.message : String(err) })
  }
}
