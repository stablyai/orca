import type { FileWithMtime } from '../ai-vault/session-scanner-types'

// Why the index keeps its own cursor: the parse cache's cursor answers "what
// does the session list already show", which is a different question from "what
// bytes of this file are already rows". They diverge the moment either side
// declines a read, so neither may consult the other.

/** Filesystem identity, when discovery could prove it. */
export type SessionSearchFileIdentity = { dev: number; ino: number } | null

/**
 * What the index holds for one transcript.
 *
 * A null `byteOffset` is a file the index holds rows for and cannot continue:
 * a chunked read committed a prefix, and the reader only hands out an offset
 * when a read finishes. Null rather than a flag because every caller that does
 * arithmetic on the offset then has to say what it means here, at compile time,
 * instead of ignoring a boolean it did not know to read.
 */
export type SessionSearchIndexedFile = {
  byteOffset: number | null
  mtimeMs: number
  sizeBytes: number | null
}

/**
 * Whether this file has to be read from the start, whatever its stat says.
 *
 * The mtime and size are the real ones, so a freshness check that compares only
 * those would call a half-written file current and never re-read it. Every such
 * check must start here.
 */
export function requiresWholeRead(indexed: SessionSearchIndexedFile | null): boolean {
  return indexed !== null && indexed.byteOffset === null
}

export function fileIdentity(file: FileWithMtime): SessionSearchFileIdentity {
  return typeof file.dev === 'number' && typeof file.ino === 'number'
    ? { dev: file.dev, ino: file.ino }
    : null
}

/**
 * True when the index already covers this file at its current stat.
 *
 * A half-written file is never current, whatever its stat says: the mtime and
 * the size on that row are the whole file's, so comparing only those would call
 * a prefix current and leave it in the index for good. This is the check
 * `requiresWholeRead` exists in front of.
 */
export function isSessionSearchFileCurrent(
  indexed: SessionSearchIndexedFile | null,
  file: FileWithMtime
): boolean {
  return (
    indexed !== null &&
    !requiresWholeRead(indexed) &&
    indexed.mtimeMs === file.mtimeMs &&
    (indexed.sizeBytes === null ||
      file.sizeBytes === undefined ||
      indexed.sizeBytes === file.sizeBytes)
  )
}
