import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileStatSignature } from '../file-stat-signature'

export { fileStatSignature as daemonHostFileStatSignature } from '../file-stat-signature'

// Metadata validation avoids rereading unchanged daemon code on the main thread.
const cachedHashes = new Map<string, { signature: string; sha256: string }>()

function statSignature(path: string): string {
  return fileStatSignature(statSync(path, { bigint: true }))
}

// Missing files must invalidate the inventory rather than reuse a cached hash.
export function hashDaemonHostFile(path: string): string {
  const before = statSignature(path)
  const cached = cachedHashes.get(path)
  if (cached?.signature === before) {
    return cached.sha256
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  // Only cache bytes proven stable across the read; a concurrent write leaves the entry absent.
  if (statSignature(path) === before) {
    cachedHashes.set(path, { signature: before, sha256 })
  } else {
    cachedHashes.delete(path)
  }
  return sha256
}

export function resetDaemonHostFileHashCacheForTests(): void {
  cachedHashes.clear()
}
