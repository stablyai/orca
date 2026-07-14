import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { listReferencedBlobHashes } from './chat-import-store'

const HASH_RE = /^[0-9a-f]{64}$/

function safeMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null // vanished between readdir and stat — ignore.
  }
}

function safeUnlink(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Remove orphan blobs (hash not referenced by any attachment row) and stale
 * `.tmp` files left by an interrupted putBlob. Files whose mtime is within
 * `graceMs` of `now` are always kept: STORE_BLOB writes a blob before the
 * later INGEST adds its attachment row, so a just-written blob looks orphaned
 * mid-sync — the grace window prevents deleting it out from under an in-flight
 * import.
 */
export function collectBlobGarbage(opts: {
  blobDir: string
  referencedHashes: Set<string>
  now: number
  graceMs: number
}): { orphanBlobs: number; staleTmp: number } {
  const result = { orphanBlobs: 0, staleTmp: 0 }
  if (!existsSync(opts.blobDir)) {
    return result
  }
  const cutoff = opts.now - opts.graceMs
  let subdirs: string[]
  try {
    subdirs = readdirSync(opts.blobDir)
  } catch {
    return result
  }
  for (const sub of subdirs) {
    const subPath = join(opts.blobDir, sub)
    let entries: string[]
    try {
      if (!statSync(subPath).isDirectory()) {
        continue
      }
      entries = readdirSync(subPath)
    } catch {
      continue
    }
    for (const name of entries) {
      const filePath = join(subPath, name)
      const mtime = safeMtimeMs(filePath)
      if (mtime === null || mtime > cutoff) {
        continue // missing or too recent to touch.
      }
      if (name.endsWith('.tmp')) {
        if (safeUnlink(filePath)) {
          result.staleTmp += 1
        }
      } else if (HASH_RE.test(name) && !opts.referencedHashes.has(name)) {
        if (safeUnlink(filePath)) {
          result.orphanBlobs += 1
        }
      }
    }
  }
  return result
}

/**
 * Remove temp attachment files older than `maxAgeMs`. Each "open attachment"
 * writes the blob to a temp file for the OS default app; those are never needed
 * once opened, so anything past the age window is safe to reclaim.
 */
export function cleanTempAttachments(opts: { tmpDir: string; now: number; maxAgeMs: number }): {
  removed: number
} {
  const result = { removed: 0 }
  if (!existsSync(opts.tmpDir)) {
    return result
  }
  const cutoff = opts.now - opts.maxAgeMs
  let entries: string[]
  try {
    entries = readdirSync(opts.tmpDir)
  } catch {
    return result
  }
  for (const name of entries) {
    const filePath = join(opts.tmpDir, name)
    const mtime = safeMtimeMs(filePath)
    if (mtime === null || mtime > cutoff) {
      continue
    }
    if (safeUnlink(filePath)) {
      result.removed += 1
    }
  }
  return result
}

export type ChatImportStorageGcResult = {
  orphanBlobs: number
  staleTmp: number
  tempRemoved: number
}

/**
 * One-shot maintenance sweep. Reads the referenced blob hashes from chats.db,
 * reclaims orphan blobs / stale temp files. If the DB is missing or can't be
 * read, blob GC is SKIPPED (never deletes blobs on an unknown reference set) —
 * only the standalone temp-attachment cleanup still runs.
 */
export function runChatImportStorageGc(opts: {
  dbPath: string
  blobDir: string
  tempAttachmentsDir: string
  now: number
  blobGraceMs: number
  tempMaxAgeMs: number
}): ChatImportStorageGcResult {
  let blobs = { orphanBlobs: 0, staleTmp: 0 }
  if (existsSync(opts.dbPath)) {
    let db: SyncDatabase | null = null
    try {
      db = new SyncDatabase(opts.dbPath, { fileMustExist: true })
      db.pragma('query_only = ON')
      if (tableExists(db, 'attachments')) {
        const referencedHashes = listReferencedBlobHashes(db)
        blobs = collectBlobGarbage({
          blobDir: opts.blobDir,
          referencedHashes,
          now: opts.now,
          graceMs: opts.blobGraceMs
        })
      }
    } catch {
      // Locked/corrupt DB → leave blobs untouched (an empty ref set would wipe
      // the store); temp cleanup below is independent and still runs.
    } finally {
      db?.close()
    }
  }
  const temp = cleanTempAttachments({
    tmpDir: opts.tempAttachmentsDir,
    now: opts.now,
    maxAgeMs: opts.tempMaxAgeMs
  })
  return { ...blobs, tempRemoved: temp.removed }
}
