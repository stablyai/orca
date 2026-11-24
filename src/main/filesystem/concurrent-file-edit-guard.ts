import { AsyncLocalStorage } from 'node:async_hooks'
import { fileIdentityKey } from './file-identity-key'

/**
 * Optimistic concurrency for a pass that edits shared files off the main thread. Each guarded
 * file remembers the bytes this pass last saw (seeded, read or published); seeing anything else
 * means another writer got in between, so the pass stops publishing and is retried.
 */

/** `undefined` marks a file unreadable when seeded; any later readable content is a change. */
type GuardedFile = { digest: string | null | undefined }
type Guard = {
  files: Map<string, GuardedFile>
  conflict: string | null
  /** The file's current digest, null when absent, undefined when unreadable. */
  readDigest: (filePath: string) => string | null | undefined
}

const guards = new AsyncLocalStorage<Guard>()

export class ConcurrentFileEditError extends Error {
  constructor(filePath: string) {
    super(`${filePath} changed while Orca was updating it`)
    this.name = 'ConcurrentFileEditError'
  }
}

function conflict(guard: Guard, filePath: string): never {
  guard.conflict ??= filePath
  throw new ConcurrentFileEditError(filePath)
}

/**
 * Runs `run` with `seeded` files guarded. Only the worker's guard scope opens one, and it brings
 * the file reader, so the checks below do no I/O on the main thread.
 */
export function runWithConcurrentFileEditGuard<T>(
  seeded: readonly { digest: string | null | undefined; aliases: readonly string[] }[],
  readDigest: Guard['readDigest'],
  run: () => T
): { value: T; conflict: string | null } {
  const files = new Map<string, GuardedFile>()
  for (const { digest, aliases } of seeded) {
    // A symlinked config is published at its target; every spelling shares one record.
    const keys = aliases.map(fileIdentityKey)
    const entry = keys.map((key) => files.get(key)).find(Boolean) ?? { digest }
    for (const key of keys) {
      files.set(key, entry)
    }
  }
  const guard: Guard = { files, conflict: null, readDigest }
  const value = guards.run(guard, run)
  return { value, conflict: guard.conflict }
}

/** Called for every observed read; a guarded file must still hold what this pass last saw. */
export function checkGuardedRead(filePath: string, readDigestOf: () => string | null): void {
  const guard = guards.getStore()
  const entry = guard?.files.get(fileIdentityKey(filePath))
  if (!guard || !entry) {
    return
  }
  if (readDigestOf() !== entry.digest) {
    conflict(guard, filePath)
  }
}

/** Call immediately before publishing or snapshotting from a guarded file. */
export function assertGuardedFileCurrent(filePath: string): void {
  const guard = guards.getStore()
  const entry = guard?.files.get(fileIdentityKey(filePath))
  if (!guard || !entry) {
    return
  }
  if (guard.conflict !== null || guard.readDigest(filePath) !== entry.digest) {
    conflict(guard, filePath)
  }
}

/** `publishedDigest` runs only for a guarded file, so unguarded writes hash nothing. */
export function recordGuardedPublication(
  filePath: string,
  publishedDigest: () => string | null
): void {
  const entry = guards.getStore()?.files.get(fileIdentityKey(filePath))
  if (entry) {
    entry.digest = publishedDigest()
  }
}
