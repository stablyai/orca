import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { renameFileWithWindowsRetry } from '../../../shared/file-write/windows-retry-file-operations'
import { utf8Head } from './item-lifecycle/journal-payload-bounds'
import { JOURNAL_ITEM_DETAIL_MAX_BYTES } from './journal-domain-item-wire'

/** Off until builds that export only a saved head are out of the downgrade window; reads always work. */
export const JOURNAL_OUTPUT_FILE_WRITES = false

export const JOURNAL_OUTPUT_FILE_DIRECTORY = 'agent-session-outputs'
const DIRECTORY = JOURNAL_OUTPUT_FILE_DIRECTORY
const WRITE_SLICE_CHARS = 1024 * 1024
export const JOURNAL_OUTPUT_FILE_STAGING = 'staging'
const STAGING = JOURNAL_OUTPUT_FILE_STAGING
const OUTPUT_FILE_ROWS = `instr(payload_json,'"outputFile":"')>0`
const OUTPUT_FILE = `(CASE WHEN json_valid(payload_json) THEN coalesce(
  json_extract(payload_json,'$.body.output.outputFile'),
  json_extract(payload_json,'$.body.patch.outputFile')) END)`

/** Rows naming one file, through the ownership index once writes build it. */
export const JOURNAL_OUTPUT_FILE_REFERENCED = `SELECT 1 FROM journal_items WHERE ${OUTPUT_FILE_ROWS} AND ${OUTPUT_FILE}=? LIMIT 1`

export const JOURNAL_OUTPUT_FILE_SCHEMA = `CREATE TABLE IF NOT EXISTS journal_output_file_unreferenced (
  digest TEXT PRIMARY KEY,
  since INTEGER NOT NULL
) WITHOUT ROWID;`

export const JOURNAL_OUTPUT_FILE_INDEX = `CREATE INDEX IF NOT EXISTS journal_items_output_file
  ON journal_items(${OUTPUT_FILE}) WHERE ${OUTPUT_FILE_ROWS};`

/** A completed output or patch kept beside the journal; `head` is its start, `outputFile` its sha256. */
export type JournalFileBackedPayload = AgentJournalBoundedPayload & { outputFile: string }

const roots = new WeakMap<Database.Database, { root: string; writes: boolean }>()

/** The writer's state directory; a database without one keeps every output inline. */
export function registerJournalOutputFileRoot(
  db: Database.Database,
  stateDirectory: string,
  writes = JOURNAL_OUTPUT_FILE_WRITES
): void {
  roots.set(db, { root: stateDirectory, writes })
}

export function journalOutputFileRoot(db: Database.Database): string | undefined {
  return roots.get(db)?.root
}

export function journalOutputFilePath(stateDirectory: string, digest: string): string {
  return join(stateDirectory, DIRECTORY, digest.slice(0, 2), `${digest}.txt`)
}

export function journalOutputFile(payload: AgentJournalBoundedPayload | undefined): string | null {
  const file: unknown = payload && 'outputFile' in payload ? payload.outputFile : undefined
  return typeof file === 'string' && /^[0-9a-f]{64}$/.test(file) ? file : null
}

/**
 * A completed tool output or patch over the detail size moves to its file before the row is
 * encoded, so the row keeps a bounded head plus the original size and digest. Any failure, or text
 * raw UTF-8 can't round-trip, keeps it inline as before.
 */
export function moveJournalItemOutputToFile<T extends AgentJournalRenderItem>(
  db: Database.Database,
  item: T
): T {
  const { root, writes } = roots.get(db) ?? { root: null, writes: false }
  const { body } = item
  const payload =
    body.kind === 'tool-call' && body.state !== 'running'
      ? body.output
      : body.kind === 'diff'
        ? body.patch
        : undefined
  const referenced = journalOutputFile(payload)
  if (root && referenced) {
    referencedAgain(db, referenced)
    return item
  }
  if (
    !writes ||
    !root ||
    !payload ||
    payload.truncated ||
    payload.head.length <= JOURNAL_ITEM_DETAIL_MAX_BYTES / 3 ||
    !payload.head.isWellFormed()
  ) {
    return item
  }
  const bytes = Buffer.byteLength(payload.head, 'utf8')
  // A size that disagrees with the text would make every export of it fail.
  if (bytes <= JOURNAL_ITEM_DETAIL_MAX_BYTES || bytes !== payload.byteLength) {
    return item
  }
  let digest: string
  try {
    digest =
      savedJournalOutputFile(root, payload.digest, bytes) ??
      saveJournalOutputFile(root, payload.head)
  } catch (error) {
    console.warn('[agent-session-journal] kept a large output inline; its file failed', error)
    return item
  }
  referencedAgain(db, digest)
  const saved: JournalFileBackedPayload = {
    head: boundedHead(payload.head),
    byteLength: payload.byteLength,
    digest: payload.digest,
    truncated: true,
    outputFile: digest
  }
  return {
    ...item,
    body: body.kind === 'diff' ? { ...body, patch: saved } : { ...body, output: saved }
  }
}

/** A file named by a row again starts its grace over the next time no row names it. */
function referencedAgain(db: Database.Database, digest: string): void {
  db.prepare('DELETE FROM journal_output_file_unreferenced WHERE digest=?').run(digest)
}

/** Escaping can grow a head up to six times, so the encoded head is what must fit: the longest that does. */
function boundedHead(text: string): string {
  const budget = JOURNAL_ITEM_DETAIL_MAX_BYTES - 64 * 1024
  const fits = (limit: number) =>
    Buffer.byteLength(JSON.stringify(utf8Head(text, limit)), 'utf8') <= budget
  let low = Math.floor(budget / 6)
  let high = budget
  while (high - low > 1024) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) {
      low = middle
    } else {
      high = middle
    }
  }
  return utf8Head(text, low)
}

/** The digest of an existing file of this content, when the payload's sha256 already names one. */
function savedJournalOutputFile(root: string, digest: string, bytes: number): string | null {
  return /^[0-9a-f]{64}$/.test(digest) && fileSize(journalOutputFilePath(root, digest)) === bytes
    ? digest
    : null
}

/**
 * Encodes and hashes the text a slice at a time into a staging file, then names it by its sha256:
 * an existing file of that name is this content. Sync, rename, then sync the folder, so the row
 * that commits after it never names a file a power loss could take back.
 */
function saveJournalOutputFile(root: string, text: string): string {
  const staging = join(root, DIRECTORY, STAGING)
  durableDirectory(staging)
  const temporary = join(staging, `${randomUUID()}.part`)
  try {
    const hash = createHash('sha256')
    let bytes = 0
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + WRITE_SLICE_CHARS)
        // Never split a surrogate pair across slices.
        if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
          end -= 1
        }
        const slice = Buffer.from(text.slice(start, end), 'utf8')
        hash.update(slice)
        for (let offset = 0; offset < slice.length;) {
          offset += writeSync(fd, slice, offset, slice.length - offset)
        }
        bytes += slice.length
        start = end
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const digest = hash.digest('hex')
    const path = journalOutputFilePath(root, digest)
    if (fileSize(path) !== bytes) {
      durableDirectory(dirname(path))
      renameFileWithWindowsRetry(temporary, path)
      syncDirectory(dirname(path))
    }
    return digest
  } finally {
    rmSync(temporary, { force: true })
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/**
 * Creates a folder and every missing one above it; each new folder is durable only once the
 * folder holding it is synced, up to the first that already existed.
 */
function durableDirectory(path: string): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 })
  for (let folder = created && path; folder;) {
    const parent = dirname(folder)
    syncDirectory(parent)
    folder = folder === created || parent === folder ? undefined : parent
  }
}

/** Makes a rename durable on POSIX; Windows has no directory handle to sync. */
function syncDirectory(path: string): void {
  if (process.platform === 'win32') {
    return
  }
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A saved body whose output moved to its file still equals the whole output it was cut from. */
export function sameJournalItemBody(
  saved: AgentJournalItemBody,
  next: AgentJournalItemBody
): boolean {
  return isDeepStrictEqual(saved, withSavedOutputFile(saved, next))
}

function withSavedOutputFile(
  saved: AgentJournalItemBody,
  next: AgentJournalItemBody
): AgentJournalItemBody {
  const matches = (
    kept: AgentJournalBoundedPayload | undefined,
    whole: AgentJournalBoundedPayload | undefined
  ) =>
    kept !== undefined &&
    whole !== undefined &&
    journalOutputFile(kept) !== null &&
    !whole.truncated &&
    whole.digest === kept.digest &&
    whole.byteLength === kept.byteLength
  if (
    saved.kind === 'tool-call' &&
    next.kind === 'tool-call' &&
    matches(saved.output, next.output)
  ) {
    return { ...next, output: saved.output }
  }
  if (saved.kind === 'diff' && next.kind === 'diff' && matches(saved.patch, next.patch)) {
    return { ...next, patch: saved.patch }
  }
  return next
}
