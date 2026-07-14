import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { chatImportBlobDir } from '../chat-import/chat-import-paths'
import { readBlob } from '../chat-import/chat-import-blobstore'

// Common blob mime types produced by the web-chat import store (Task 1-3).
// Unrecognized mimes fall back to `.bin` so the sanitized name always has an
// extension for the OS's "open with" resolution.
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip'
}

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? '.bin'
}

// Why: fileName is stored data from a browser-side import, not something Orca
// controls — split on both separators regardless of host OS (a Windows-origin
// import can still carry backslashes when Orca runs on macOS/Linux) and drop
// `.`/`..` segments so the result can never escape tmpDir.
function lastPathSegment(fileName: string): string {
  const segments = fileName
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  return segments.at(-1) ?? 'attachment'
}

// Security: web-chat fileName/mime metadata is untrusted. Preserving the
// fileName's own extension would let a hostile attachment (e.g.
// fileName='invoice.exe', mime='image/png') be written and opened as an
// executable. The output extension always comes from the mime allowlist.
export function sanitizeAttachmentFileName(fileName: string, mime: string): string {
  const base = lastPathSegment(fileName.trim())
  const stem = base.replace(/\.[^./\\]*$/, '').replace(/\.+$/, '') || 'attachment'
  return `${stem}${extensionForMime(mime)}`
}

export type ChatImportAttachmentOpenArgs = {
  hash: string
  fileName: string
  mime: string
}

export type ChatImportAttachmentOpenResult = { ok: true } | { ok: false; error: string }

// Pure/injectable: readBlobFn and tmpDir come from the caller so this can be
// unit-tested without electron or a real userData blob store.
export function writeAttachmentTemp(
  readBlobFn: (hash: string) => Buffer | null,
  tmpDir: string,
  args: ChatImportAttachmentOpenArgs
): string {
  const bytes = readBlobFn(args.hash)
  if (!bytes) {
    throw new Error(`Attachment blob not found for hash ${args.hash}`)
  }
  mkdirSync(tmpDir, { recursive: true })
  const destination = join(tmpDir, sanitizeAttachmentFileName(args.fileName, args.mime))
  writeFileSync(destination, bytes)
  return destination
}

export type OpenStoredAttachmentDeps = {
  readBlob: (hash: string) => Buffer | null
  openPath: (path: string) => Promise<string>
  tmpDir: string
}

// Pure/injectable: keeps the openPath-failure branch unit-testable without electron.
export async function openStoredAttachment(
  deps: OpenStoredAttachmentDeps,
  args: ChatImportAttachmentOpenArgs
): Promise<ChatImportAttachmentOpenResult> {
  try {
    const path = writeAttachmentTemp(deps.readBlob, deps.tmpDir, args)
    // shell.openPath never rejects on failure — it resolves an error message
    // string ('' on success), so the result must be inspected explicitly.
    const error = await deps.openPath(path)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerChatImportAttachmentHandlers(): void {
  ipcMain.handle(
    'chatImportAttachment:open',
    async (_event, args: ChatImportAttachmentOpenArgs): Promise<ChatImportAttachmentOpenResult> =>
      openStoredAttachment(
        {
          readBlob: (hash) => readBlob(chatImportBlobDir(), hash),
          openPath: (path) => shell.openPath(path),
          tmpDir: join(app.getPath('temp'), 'orca-attachments')
        },
        args
      )
  )
}
