import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileStatSignature } from '../../../filesystem/file-stat-signature'

// Metadata validation avoids rereading unchanged daemon code on the main thread.
const cachedHashes = new Map<string, { signature: string; sha256: string }>()

function statSignature(path: string): string {
  return fileStatSignature(statSync(path, { bigint: true }))
}

// Only cache bytes proven stable across the read; a concurrent write leaves the entry absent.
function recordHash(path: string, before: string, after: string, sha256: string): string {
  if (after === before) {
    cachedHashes.set(path, { signature: before, sha256 })
  } else {
    cachedHashes.delete(path)
  }
  return sha256
}

/** Record a hash whose signature the caller proved stable across its read (a verified copy). */
export function seedDaemonHostFileHash(path: string, signature: string, sha256: string): void {
  cachedHashes.set(path, { signature, sha256 })
}

// Missing files must invalidate the inventory rather than reuse a cached hash.
export function hashDaemonHostFile(path: string): string {
  const before = statSignature(path)
  const cached = cachedHashes.get(path)
  if (cached?.signature === before) {
    return cached.sha256
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  return recordHash(path, before, statSignature(path), sha256)
}

/** Stream the hash so large files never hold the event loop for a whole read. */
export async function hashDaemonHostFileAsync(path: string): Promise<string> {
  const before = fileStatSignature(await stat(path, { bigint: true }))
  const cached = cachedHashes.get(path)
  if (cached?.signature === before) {
    return cached.sha256
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  const sha256 = hash.digest('hex')
  return recordHash(path, before, fileStatSignature(await stat(path, { bigint: true })), sha256)
}
