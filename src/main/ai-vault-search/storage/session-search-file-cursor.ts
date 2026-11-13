import type { FileWithMtime } from '../../ai-vault/session-scanner-types'

// Index and parse-cache cursors can diverge when either declines a read; track them independently.

export type SessionSearchFileIdentity = { dev: number; ino: number } | null

/** Everything a failed read observed, so a held-out file is retried when any part of its source moves. */
export type SessionSearchFailureStat = {
  mtimeMs: number
  /** Null when the read saw no sidecar or could not stat it; a later stat then proves a change. */
  sidecarMtimeMs: number | null
  sidecarSizeBytes: number | null
}

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

/** Record the stat a failed read observed, including the sidecar that would have supplied messages. */
export function sessionSearchFailureStat(file: FileWithMtime): SessionSearchFailureStat {
  const sidecar = typeof file.sidecar === 'object' ? file.sidecar : null
  return {
    mtimeMs: file.mtimeMs,
    sidecarMtimeMs: sidecar?.mtimeMs ?? null,
    sidecarSizeBytes: sidecar?.sizeBytes ?? null
  }
}
