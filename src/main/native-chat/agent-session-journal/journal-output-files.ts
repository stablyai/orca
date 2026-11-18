import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
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

const DIRECTORY = 'agent-session-outputs'
// A capture or fork that read a reference before its row went keeps the file through this window.
const UNREFERENCED_GRACE_MS = 24 * 60 * 60 * 1000
const WRITE_SLICE_CHARS = 1024 * 1024
const STAGING = 'staging'
const OUTPUT_FILE_ROWS = `instr(payload_json,'"outputFile":"')>0`
const OUTPUT_FILE = `(CASE WHEN json_valid(payload_json) THEN coalesce(
  json_extract(payload_json,'$.body.output.outputFile'),
  json_extract(payload_json,'$.body.patch.outputFile')) END)`

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
  if (
    !writes ||
    !root ||
    !payload ||
    payload.truncated ||
    journalOutputFile(payload) ||
    payload.head.length <= JOURNAL_ITEM_DETAIL_MAX_BYTES / 3 ||
    !payload.head.isWellFormed()
  ) {
    return item
  }
  if (Buffer.byteLength(payload.head, 'utf8') <= JOURNAL_ITEM_DETAIL_MAX_BYTES) {
    return item
  }
  let digest: string
  try {
    digest = saveJournalOutputFile(root, payload.head)
  } catch (error) {
    console.warn('[agent-session-journal] kept a large output inline; its file failed', error)
    return item
  }
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

/** Escaping can grow a head up to six times, so the encoded head is what must fit. */
function boundedHead(text: string): string {
  let limit = JOURNAL_ITEM_DETAIL_MAX_BYTES - 64 * 1024
  for (;;) {
    const head = utf8Head(text, limit)
    if (
      Buffer.byteLength(JSON.stringify(head), 'utf8') <=
      JOURNAL_ITEM_DETAIL_MAX_BYTES - 64 * 1024
    ) {
      return head
    }
    limit = Math.floor(limit / 2)
  }
}

/**
 * Encodes and hashes the text a slice at a time into a staging file, then names it by its sha256:
 * an existing file of that name is this content. Sync, rename, then sync the folder, so the row
 * that commits after it never names a file a power loss could take back.
 */
function saveJournalOutputFile(root: string, text: string): string {
  const staging = join(root, DIRECTORY, STAGING)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
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
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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

export type JournalOutputFileSweepResult = {
  kind: 'output-file-sweep'
  more: boolean
  files: number
  bytes: number
  removed: number
  freedBytes: number
}

// One unit per call: each of the 256 digest shards, then the staging folder.
const SWEEP_UNITS = 257
const sweepCursors = new WeakMap<Database.Database, number>()

/**
 * One bounded unit of the sweep: removes files no row has referenced for the grace window, and
 * staging files a crash left; a referenced file is never touched.
 */
export function sweepJournalOutputFiles(
  db: Database.Database,
  now: number
): JournalOutputFileSweepResult {
  const unit = sweepCursors.get(db) ?? 0
  const more = unit + 1 < SWEEP_UNITS
  sweepCursors.set(db, more ? unit + 1 : 0)
  const result = {
    kind: 'output-file-sweep' as const,
    more,
    files: 0,
    bytes: 0,
    removed: 0,
    freedBytes: 0
  }
  const root = roots.get(db)?.root
  if (!root) {
    return result
  }
  if (unit === SWEEP_UNITS - 1) {
    for (const entry of listFiles(join(root, DIRECTORY, STAGING))) {
      // A live write renames within its own transaction; an old one was left by a crash.
      if (entry.modifiedAt <= now - UNREFERENCED_GRACE_MS) {
        rmSync(entry.path, { force: true })
      }
    }
    return result
  }
  const shard = unit.toString(16).padStart(2, '0')
  const files = listFiles(join(root, DIRECTORY, shard)).filter((entry) =>
    /^[0-9a-f]{64}\.txt$/.test(entry.name)
  )
  const referenced = db.prepare(
    `SELECT 1 FROM journal_items WHERE ${OUTPUT_FILE_ROWS} AND ${OUTPUT_FILE}=? LIMIT 1`
  )
  const mark = db.prepare(
    'INSERT OR IGNORE INTO journal_output_file_unreferenced(digest,since) VALUES(?,?)'
  )
  const since = db.prepare('SELECT since FROM journal_output_file_unreferenced WHERE digest=?')
  const clear = db.prepare('DELETE FROM journal_output_file_unreferenced WHERE digest=?')
  db.prepare(`DELETE FROM journal_output_file_unreferenced WHERE substr(digest,1,2)=?
    AND digest NOT IN (SELECT value FROM json_each(?))`).run(
    shard,
    JSON.stringify(files.map((entry) => entry.name.slice(0, 64)))
  )
  for (const { name, path, size } of files) {
    const digest = name.slice(0, 64)
    result.files++
    result.bytes += size
    if (referenced.get(digest)) {
      clear.run(digest)
      continue
    }
    mark.run(digest, now)
    if (Number(since.get(digest)!.since) > now - UNREFERENCED_GRACE_MS) {
      continue
    }
    try {
      rmSync(path, { force: true, maxRetries: 8, retryDelay: 150 })
      clear.run(digest)
      result.removed++
      result.freedBytes += size
    } catch (error) {
      console.warn('[agent-session-journal] could not remove an unreferenced output file', error)
    }
  }
  if (result.removed > 0) {
    console.info(
      `[agent-session-journal] removed ${result.removed} unreferenced output files (${result.freedBytes} bytes) in shard ${shard}`
    )
  }
  return result
}

function listFiles(
  directory: string
): { name: string; path: string; size: number; modifiedAt: number }[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const path = join(directory, name)
    try {
      const stat = statSync(path)
      return stat.isFile() ? [{ name, path, size: stat.size, modifiedAt: stat.mtimeMs }] : []
    } catch {
      return []
    }
  })
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
