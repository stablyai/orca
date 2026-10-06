import type { Dir, Stats } from 'node:fs'
import { lstat, mkdir, opendir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const SWEEP_CONCURRENCY = 8
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
} as const

type CleanupResult = 'failed' | 'fresh' | 'ignored' | 'removed'

export type OwnedDirectorySweepResult = {
  complete: boolean
  hasFailures: boolean
  hasFreshDirectories: boolean
}

/** Per-user, so one account cannot hand another a root it controls in a shared temp dir. */
export function getOwnedTempStagingRoot(tempRoot: string, rootName: string): string {
  const uidSuffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
  return join(tempRoot, `${rootName}${uidSuffix}`)
}

/** Create the root if needed; false when what is there is not a private directory we own. */
export async function ensureOwnedTempStagingRoot(stagingRoot: string): Promise<boolean> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  return isSafeOwnedDirectory(await lstat(stagingRoot))
}

export function isSafeOwnedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false
  }
  if (typeof process.getuid !== 'function') {
    return true
  }
  return stats.uid === process.getuid() && (stats.mode & 0o777) === 0o700
}

export function isDirectChild(parent: string, candidate: string): boolean {
  return dirname(resolve(candidate)) === resolve(parent)
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Remove owned child directories of `root` whose mtime is at least `ttlMs` old. */
export async function sweepExpiredOwnedDirectories(
  root: string,
  options: {
    nowMs: number
    ttlMs: number
    ownsEntry: (name: string) => boolean
    entryLimit?: number
  }
): Promise<OwnedDirectorySweepResult> {
  const entryLimit = options.entryLimit ?? Number.POSITIVE_INFINITY
  let rootDir: Dir
  try {
    rootDir = await opendir(root)
  } catch {
    return { complete: false, hasFailures: false, hasFreshDirectories: false }
  }

  let complete = true
  let entriesVisited = 0
  let hasFailures = false
  let hasFreshDirectories = false
  const pending = new Set<Promise<void>>()
  try {
    for await (const entry of rootDir) {
      entriesVisited += 1
      if (entry.isDirectory() && options.ownsEntry(entry.name)) {
        const candidate = join(root, entry.name)
        if (isDirectChild(root, candidate)) {
          const cleanup = cleanupDirectory(candidate, options.nowMs, options.ttlMs).then(
            (result) => {
              hasFailures ||= result === 'failed'
              hasFreshDirectories ||= result === 'fresh'
            }
          )
          pending.add(cleanup)
          void cleanup.finally(() => pending.delete(cleanup))
          if (pending.size >= SWEEP_CONCURRENCY) {
            await Promise.race(pending)
          }
        }
      }
      if (entriesVisited >= entryLimit) {
        break
      }
    }
  } catch {
    complete = false
  } finally {
    await rootDir.close().catch(() => undefined)
  }
  await Promise.all(pending)
  return { complete, hasFailures, hasFreshDirectories }
}

export async function removeOwnedDirectory(directory: string): Promise<void> {
  await rm(directory, REMOVE_OPTIONS)
}

async function cleanupDirectory(
  directory: string,
  nowMs: number,
  ttlMs: number
): Promise<CleanupResult> {
  try {
    const directoryStats = await lstat(directory)
    if (!isSafeOwnedDirectory(directoryStats)) {
      return 'ignored'
    }
    if (nowMs - directoryStats.mtimeMs < ttlMs) {
      return 'fresh'
    }
    await removeOwnedDirectory(directory)
    return 'removed'
  } catch (error) {
    return isMissingPathError(error) ? 'ignored' : 'failed'
  }
}
