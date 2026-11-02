import type { FileWithMtime } from '../ai-vault/session-scanner-types'

// Index and parse-cache cursors can diverge when either declines a read; track them independently.

export type SessionSearchFileIdentity = { dev: number; ino: number } | null

/** A null byteOffset marks a committed prefix that needs a whole read before it can resume. */
export type SessionSearchIndexedFile = {
  byteOffset: number | null
  mtimeMs: number
  sizeBytes: number | null
}

/** Partial writes require whole reads even when mtime and size still match. */
export function requiresWholeRead(indexed: SessionSearchIndexedFile | null): boolean {
  return indexed !== null && indexed.byteOffset === null
}

export function fileIdentity(file: FileWithMtime): SessionSearchFileIdentity {
  return typeof file.dev === 'number' && typeof file.ino === 'number'
    ? { dev: file.dev, ino: file.ino }
    : null
}
