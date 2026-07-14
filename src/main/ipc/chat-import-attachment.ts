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

export function sanitizeAttachmentFileName(fileName: string, mime: string): string {
  const base = lastPathSegment(fileName.trim())
  const hasExtension = /\.[^./\\]+$/.test(base)
  return hasExtension ? base : `${base}${extensionForMime(mime)}`
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

export function registerChatImportAttachmentHandlers(): void {
  ipcMain.handle(
    'chatImportAttachment:open',
    async (_event, args: ChatImportAttachmentOpenArgs): Promise<ChatImportAttachmentOpenResult> => {
      try {
        const path = writeAttachmentTemp(
          (hash) => readBlob(chatImportBlobDir(), hash),
          join(app.getPath('temp'), 'orca-attachments'),
          args
        )
        await shell.openPath(path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
