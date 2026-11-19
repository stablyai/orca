import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { fileIdentityKey } from './file-identity-key'

/**
 * Optimistic concurrency for a pass that edits shared files off the main thread. Each guarded
 * file remembers the bytes this pass last saw (seeded, read or published); seeing anything else
 * means another writer got in between, so the pass stops publishing and is retried.
 */

type GuardedFile = { digest: string | null }
type Guard = { files: Map<string, GuardedFile>; conflict: string | null }

const guards = new AsyncLocalStorage<Guard>()

export class ConcurrentFileEditError extends Error {
  constructor(filePath: string) {
    super(`${filePath} changed while Orca was updating it`)
    this.name = 'ConcurrentFileEditError'
  }
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function readDigest(filePath: string): string | null | undefined {
  try {
    return digest(readFileSync(filePath))
  } catch (error) {
    // Unknown read failures leave the file unguarded; its own writer reports them.
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

function conflict(guard: Guard, filePath: string): never {
  guard.conflict ??= filePath
  throw new ConcurrentFileEditError(filePath)
}

/**
 * Runs `run` with `seedPaths` guarded from their current bytes. Returns the first conflicting
 * path, if any: callers swallow write errors in places, so the result, not the throw, decides a retry.
 */
export function withConcurrentFileEditGuard<T>(
  seedPaths: readonly string[],
  run: () => T
): { value: T; conflict: string | null } {
  const files = new Map<string, GuardedFile>()
  for (const filePath of seedPaths) {
    const seeded = readDigest(filePath)
    if (seeded === undefined) {
      continue
    }
    const entry = { digest: seeded }
    files.set(fileIdentityKey(filePath), entry)
    try {
      // A symlinked config is published at its target; both spellings share one record.
      files.set(fileIdentityKey(realpathSync.native(filePath)), entry)
    } catch {
      // Absent or unresolvable: the spelled path is the only one written.
    }
  }
  const guard: Guard = { files, conflict: null }
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
  if (guard.conflict !== null || readDigest(filePath) !== entry.digest) {
    conflict(guard, filePath)
  }
}

export function recordGuardedPublication(filePath: string, published: string | null): void {
  const entry = guards.getStore()?.files.get(fileIdentityKey(filePath))
  if (entry) {
    entry.digest = published
  }
}
