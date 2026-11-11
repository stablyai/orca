// Files for an agent to read (POST /v1/workspaces/:id/attachments, MCP upload_attachment). The
// bytes go straight onto the workspace's own disk through the provider's files API, outside the
// repo so they never show up in git status; D1 keeps only the metadata a message references.
import { z } from 'zod'
import { ApiError } from './caller'
import { randomId } from './keys'

export const ATTACHMENTS_ROOT = '/vercel/sandbox/attachments'
/** Raw uploads (curl --data-binary). Workers buffer the body, so this stays well under memory. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** JSON uploads carry base64 (MCP tool calls): the MCP request cap bounds them. */
export const MAX_JSON_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

export type AttachmentRow = {
  id: string
  sandbox_id: string
  account_id: string
  uploaded_by: string
  filename: string
  content_type: string
  byte_size: number
  path: string
  created_at: number
}

export function attachmentView(row: AttachmentRow) {
  return {
    id: row.id,
    workspaceId: row.sandbox_id,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
    path: row.path,
    createdAt: row.created_at
  }
}

/** A name safe for one path segment: ASCII letters, digits, `._-` and spaces; never hidden, never empty. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).at(-1) ?? ''
  const cleaned = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  const capped = cleaned.length > 100 ? `${cleaned.slice(0, 80)}${cleaned.slice(cleaned.lastIndexOf('.')).slice(0, 20)}` : cleaned
  return capped || 'file'
}

const ContentType = z.string().trim().min(3).max(127).regex(/^[\w.+-]+\/[\w.+-]+$/)

const JsonUpload = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: ContentType.optional(),
    /** Base64 (standard or url-safe) file bytes. */
    data: z.string().min(1).max(Math.ceil((MAX_JSON_ATTACHMENT_BYTES * 4) / 3) + 4)
  })
  .strict()

function decodeBase64(data: string): Uint8Array {
  const normal = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normal)) {
    throw new ApiError(400, 'invalid_request', 'data: not base64')
  }
  const binary = atob(normal)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Reads an upload: JSON `{filename, contentType?, data}` (base64), or the raw bytes with
 * `?filename=` and the file's own Content-Type.
 */
export async function readUpload(request: Request, url: URL): Promise<{ filename: string; contentType: string; bytes: Uint8Array }> {
  const declared = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const length = Number(request.headers.get('content-length') ?? NaN)
  if (declared === 'application/json') {
    if (length > MAX_JSON_ATTACHMENT_BYTES * 1.4) {
      throw new ApiError(413, 'too_large', `max ${MAX_JSON_ATTACHMENT_BYTES} bytes as JSON; upload larger files raw`)
    }
    const parsed = JsonUpload.safeParse(JSON.parse(await request.text()))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new ApiError(400, 'invalid_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined)
    }
    const bytes = decodeBase64(parsed.data.data)
    if (bytes.length > MAX_JSON_ATTACHMENT_BYTES) {
      throw new ApiError(413, 'too_large', `max ${MAX_JSON_ATTACHMENT_BYTES} bytes as JSON; upload larger files raw`)
    }
    return { filename: parsed.data.filename, contentType: parsed.data.contentType ?? 'application/octet-stream', bytes }
  }
  const filename = url.searchParams.get('filename')
  if (!filename || filename.length > 255) {
    throw new ApiError(400, 'invalid_request', 'filename: required query parameter for raw uploads')
  }
  if (length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, 'too_large', `max ${MAX_ATTACHMENT_BYTES} bytes`)
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, 'too_large', `max ${MAX_ATTACHMENT_BYTES} bytes`)
  }
  const contentType = ContentType.safeParse(declared)
  return { filename, contentType: contentType.success ? contentType.data : 'application/octet-stream', bytes }
}

export function newAttachment(input: { sandboxId: string; accountId: string; uploadedBy: string; filename: string; contentType: string; byteSize: number }, now: number): AttachmentRow {
  const id = randomId('att')
  const filename = safeFilename(input.filename)
  return {
    id,
    sandbox_id: input.sandboxId,
    account_id: input.accountId,
    uploaded_by: input.uploadedBy,
    filename,
    content_type: input.contentType,
    byte_size: input.byteSize,
    path: `${ATTACHMENTS_ROOT}/${id}/${filename}`,
    created_at: now
  }
}

export async function insertAttachment(db: D1Database, row: AttachmentRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspace_attachments (id, sandbox_id, account_id, uploaded_by, filename, content_type, byte_size, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.sandbox_id, row.account_id, row.uploaded_by, row.filename, row.content_type, row.byte_size, row.path, row.created_at)
    .run()
}

/** The named attachments of this workspace, in the order given; 400 if any is unknown or elsewhere. */
export async function resolveAttachments(db: D1Database, sandboxId: string, ids: readonly string[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) {
    return []
  }
  const unique = [...new Set(ids)]
  const { results } = await db
    .prepare(`SELECT * FROM workspace_attachments WHERE sandbox_id = ? AND id IN (${unique.map(() => '?').join(', ')})`)
    .bind(sandboxId, ...unique)
    .all<AttachmentRow>()
  const byId = new Map(results.map((row) => [row.id, row]))
  const missing = unique.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new ApiError(400, 'invalid_request', `attachments: unknown in this workspace: ${missing.join(',').slice(0, 200)}`)
  }
  return unique.map((id) => byId.get(id)!)
}

/** The message text an agent gets: the user's words, then where each attached file is on disk. */
export function withAttachmentPaths(text: string, attachments: readonly AttachmentRow[]): string {
  if (attachments.length === 0) {
    return text
  }
  const lines = attachments.map((row) => `- ${row.path} (${row.content_type}, ${row.byte_size} bytes)`)
  return `${text}\n\nAttached files (read them from disk):\n${lines.join('\n')}`
}
