// Content-addressed store for the remainder of a bounded payload.
//
// Blobs are named by their sha256, so writing the same output twice costs one
// file and re-import is idempotent. They live beside the journal (host-side
// per-workspace state, never inside the user's working tree) and share the
// epoch's retention: compaction prunes every blob no retained row references.

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'

const BLOB_DIR = 'blobs'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** A digest arrives back from a row on disk, so it is untrusted by the time it
 *  reaches the filesystem: anything but a bare sha256 could escape the store. */
function blobPath(journalDir: string, digest: string): string | null {
  return DIGEST_PATTERN.test(digest) ? join(journalDir, BLOB_DIR, digest) : null
}

/** Persist `payload` under its digest. Returns the digest so the caller can
 *  stamp it on the row it is about to append. */
export async function putJournalBlob(
  journalDir: string,
  digest: string,
  payload: string
): Promise<string> {
  const target = blobPath(journalDir, digest)
  if (!target) {
    throw new Error('refusing to write a journal blob under a name that is not a sha256 digest')
  }
  // Content addressing makes a rewrite pointless: identical digest, identical bytes.
  if (await pathExists(target)) {
    return digest
  }
  await mkdir(join(journalDir, BLOB_DIR), { recursive: true })
  await writeFileDurable(durableWriteTempPath(target), target, payload)
  return digest
}

export async function readJournalBlob(journalDir: string, digest: string): Promise<string | null> {
  const source = blobPath(journalDir, digest)
  if (!source) {
    return null
  }
  try {
    return await readFile(source, 'utf-8')
  } catch {
    return null
  }
}

/** Remove a blob written speculatively for a row that was rejected. */
export async function removeJournalBlob(journalDir: string, digest: string): Promise<void> {
  const target = blobPath(journalDir, digest)
  if (target) {
    await rm(target, { force: true })
  }
}

/** Drop every blob outside `retained`. Called from compaction, under the
 *  current lease fence, after the snapshot is durable — so a crash mid-prune
 *  leaves extra blobs rather than dangling references. */
export async function pruneJournalBlobs(
  journalDir: string,
  retained: ReadonlySet<string>
): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(join(journalDir, BLOB_DIR))
  } catch {
    return 0
  }
  for (const name of names) {
    if (retained.has(name)) {
      continue
    }
    await rm(join(journalDir, BLOB_DIR, name), { force: true }).catch(() => {})
    removed += 1
  }
  return removed
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
