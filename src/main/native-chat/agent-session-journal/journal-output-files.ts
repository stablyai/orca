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
const WRITE_SLICE_BYTES = 1024 * 1024
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
  const bytes = Buffer.from(payload.head, 'utf8')
  if (bytes.length <= JOURNAL_ITEM_DETAIL_MAX_BYTES) {
    return item
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  try {
    saveJournalOutputFile(journalOutputFilePath(root, digest), bytes)
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

/** Immutable by name: an existing file of the right size is this content; else write, sync, rename. */
function saveJournalOutputFile(path: string, bytes: Buffer): void {
  try {
    if (statSync(path).size === bytes.length) {
      return
    }
  } catch {
    // Missing: write it below.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.part`
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      for (let offset = 0; offset < bytes.length;) {
        offset += writeSync(fd, bytes, offset, Math.min(WRITE_SLICE_BYTES, bytes.length - offset))
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameFileWithWindowsRetry(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export type JournalOutputFileSweepResult = {
  kind: 'output-file-sweep'
  files: number
  bytes: number
  removed: number
  freedBytes: number
}

/** Removes files no row has referenced for the grace window; referenced ones are never touched. */
export function sweepJournalOutputFiles(
  db: Database.Database,
  now: number
): JournalOutputFileSweepResult {
  const result: JournalOutputFileSweepResult = {
    kind: 'output-file-sweep',
    files: 0,
    bytes: 0,
    removed: 0,
    freedBytes: 0
  }
  const root = roots.get(db)?.root
  const files = root ? listJournalOutputFiles(join(root, DIRECTORY)) : []
  if (!root || files.length === 0) {
    db.prepare('DELETE FROM journal_output_file_unreferenced').run()
    return result
  }
  const referenced = new Set(
    db
      .prepare(
        `SELECT DISTINCT ${OUTPUT_FILE} AS digest FROM journal_items WHERE ${OUTPUT_FILE_ROWS}`
      )
      .all()
      .map((row) => String(row.digest))
  )
  const mark = db.prepare(
    'INSERT OR IGNORE INTO journal_output_file_unreferenced(digest,since) VALUES(?,?)'
  )
  const since = db.prepare('SELECT since FROM journal_output_file_unreferenced WHERE digest=?')
  const clear = db.prepare('DELETE FROM journal_output_file_unreferenced WHERE digest=?')
  for (const { digest, path, size, staged, modifiedAt } of files) {
    if (staged) {
      // A crash between write and rename; a live write renames within its own transaction.
      if (modifiedAt <= now - UNREFERENCED_GRACE_MS) {
        rmSync(path, { force: true })
      }
      continue
    }
    result.files++
    result.bytes += size
    if (referenced.has(digest)) {
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
      `[agent-session-journal] removed ${result.removed} unreferenced output files (${result.freedBytes} bytes); ${result.files - result.removed} kept`
    )
  }
  return result
}

type JournalOutputFileEntry = {
  digest: string
  path: string
  size: number
  staged: boolean
  modifiedAt: number
}

function listJournalOutputFiles(directory: string): JournalOutputFileEntry[] {
  const files: JournalOutputFileEntry[] = []
  let shards: string[]
  try {
    shards = readdirSync(directory)
  } catch {
    return files
  }
  for (const shard of shards) {
    let names: string[]
    try {
      names = readdirSync(join(directory, shard))
    } catch {
      continue
    }
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.txt(\.[0-9a-f-]+\.part)?$/.exec(name)
      if (!match) {
        continue
      }
      const path = join(directory, shard, name)
      try {
        const stat = statSync(path)
        files.push({
          digest: match[1],
          path,
          size: stat.size,
          staged: match[2] !== undefined,
          modifiedAt: stat.mtimeMs
        })
      } catch {
        // Removed meanwhile.
      }
    }
  }
  return files
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
