import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import { JOURNAL_OUTPUT_FILE_DIRECTORY } from './journal-output-file-references'
import {
  JOURNAL_OUTPUT_FILE_REFERENCED,
  JOURNAL_OUTPUT_FILE_STAGING,
  journalOutputFileRoot
} from './journal-output-files'

// A capture or fork that read a reference before its row went keeps the file through this window.
const UNREFERENCED_GRACE_MS = 24 * 60 * 60 * 1000

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
  const root = journalOutputFileRoot(db)
  if (!root) {
    return result
  }
  if (unit === SWEEP_UNITS - 1) {
    for (const entry of listFiles(
      join(root, JOURNAL_OUTPUT_FILE_DIRECTORY, JOURNAL_OUTPUT_FILE_STAGING)
    )) {
      // A live write renames within its own transaction; an old one was left by a crash.
      if (entry.modifiedAt <= now - UNREFERENCED_GRACE_MS) {
        try {
          rmSync(entry.path, { force: true })
        } catch (error) {
          // A file another process holds is retried by the next sweep; the rest still go.
          console.warn('[agent-session-journal] could not remove a stale staging file', error)
        }
      }
    }
    return result
  }
  const shard = unit.toString(16).padStart(2, '0')
  const files = listFiles(join(root, JOURNAL_OUTPUT_FILE_DIRECTORY, shard)).filter((entry) =>
    /^[0-9a-f]{64}\.txt$/.test(entry.name)
  )
  // Without the ownership index (writes never on here), proving a file unreferenced would scan
  // every row, so its files are kept.
  if (
    !db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name='journal_items_output_file'`
      )
      .get()
  ) {
    return result
  }
  const referenced = db.prepare(JOURNAL_OUTPUT_FILE_REFERENCED)
  const mark = db.prepare(
    'INSERT OR IGNORE INTO journal_output_file_unreferenced(digest,since) VALUES(?,?)'
  )
  const since = db.prepare('SELECT since FROM journal_output_file_unreferenced WHERE digest=?')
  const clear = db.prepare('DELETE FROM journal_output_file_unreferenced WHERE digest=?')
  // A key range, so each unit visits only its own shard's markers.
  db.prepare(`DELETE FROM journal_output_file_unreferenced WHERE digest>=? AND digest<?
    AND digest NOT IN (SELECT value FROM json_each(?))`).run(
    shard,
    `${shard}~`,
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
      // One attempt: a file an export holds open is retried by the next sweep, not the writer.
      rmSync(path, { force: true })
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
