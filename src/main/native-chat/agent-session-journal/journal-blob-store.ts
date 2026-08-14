// Content-addressed store for the remainder of a bounded payload.
//
// Blobs are named by their sha256, so writing the same output twice costs one
// file and re-import is idempotent. They live beside the journal (host-side
// per-workspace state, never inside the user's working tree) and share the
// epoch's retention: compaction prunes every blob no retained row references.

import { constants } from 'node:fs'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'
import { digestPayload } from './journal-payload-bounds'

const BLOB_DIR = 'blobs'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export type JournalBlobPayload = { digest: string; payload: string }

export type JournalBlobWritePlan = {
  blobs: readonly (JournalBlobPayload & { byteLength: number })[]
  additionalBytes: number
}

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
  const plan = await planJournalBlobWrites(journalDir, [{ digest, payload }])
  await commitJournalBlobWritePlan(journalDir, plan)
  return digest
}

/** Resolve the bytes a set of content-addressed blobs would add without
 *  mutating disk. Journal row/rate admission consumes this plan first. */
export async function planJournalBlobWrites(
  journalDir: string,
  blobs: readonly JournalBlobPayload[]
): Promise<JournalBlobWritePlan> {
  const unique = new Map<string, string>()
  for (const blob of blobs) {
    if (!blobPath(journalDir, blob.digest)) {
      throw new Error('refusing to write a journal blob under a name that is not a sha256 digest')
    }
    if (digestPayload(blob.payload) !== blob.digest) {
      throw new Error(`journal blob digest ${blob.digest} does not match its payload`)
    }
    const duplicate = unique.get(blob.digest)
    if (duplicate !== undefined && duplicate !== blob.payload) {
      throw new Error(`journal blob digest ${blob.digest} has conflicting payloads`)
    }
    unique.set(blob.digest, blob.payload)
  }

  const planned: (JournalBlobPayload & { byteLength: number })[] = []
  let additionalBytes = 0
  for (const [digest, payload] of unique) {
    if ((await readValidatedBlob(journalDir, digest)) !== null) {
      continue
    }
    const byteLength = Buffer.byteLength(payload, 'utf8')
    planned.push({ digest, payload, byteLength })
    additionalBytes += byteLength
  }
  return { blobs: planned, additionalBytes }
}

/** Commit only a plan that the journal budget has already admitted. */
export async function commitJournalBlobWritePlan(
  journalDir: string,
  plan: JournalBlobWritePlan
): Promise<number> {
  if (plan.blobs.length === 0) {
    return 0
  }
  await mkdir(join(journalDir, BLOB_DIR), { recursive: true })
  let addedBytes = 0
  for (const blob of plan.blobs) {
    const target = blobPath(journalDir, blob.digest) as string
    // The journal serializes appends. Replacing the name also prevents a
    // symlink or hard link inserted after planning from being followed.
    await writeFileDurable(durableWriteTempPath(target), target, blob.payload)
    addedBytes += blob.byteLength
  }
  return addedBytes
}

export async function readJournalBlob(journalDir: string, digest: string): Promise<string | null> {
  return blobPath(journalDir, digest) ? readValidatedBlob(journalDir, digest) : null
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

async function readValidatedBlob(journalDir: string, digest: string): Promise<string | null> {
  const source = blobPath(journalDir, digest)
  if (!source) {
    return null
  }
  let handle
  try {
    handle = await openBlobFile(source)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
  try {
    const info = await handle.stat()
    assertRegularSingleLinkBlob(info, digest)
    const payload = await handle.readFile('utf8')
    if (digestPayload(payload) !== digest) {
      throw new Error(`journal blob ${digest} does not match its content digest`)
    }
    return payload
  } finally {
    await handle.close()
  }
}

function openBlobFile(path: string) {
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
}

function assertRegularSingleLinkBlob(info: { isFile(): boolean; nlink: number }, digest: string) {
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error(`journal blob ${digest} is not a regular single-link file`)
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
