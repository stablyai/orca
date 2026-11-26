import type { Dir } from 'node:fs'
import { access, constants as fsConstants, opendir, stat } from 'node:fs/promises'
import path from 'node:path'
import { forEachWithConcurrency } from '../../../shared/concurrency/map-with-concurrency'

const MAX_DETECTION_DIRECTORY_ENTRIES = 128

export function directoryNameKey(name: string): string {
  return name.normalize('NFD').toLowerCase()
}

export async function isExecutableFile(candidate: string, isWin: boolean): Promise<boolean> {
  try {
    // Follow symlinked CLIs to their real targets.
    const stats = await stat(candidate)
    if (stats.isDirectory()) {
      // PATH directories are not executable files despite their search bit.
      return false
    }
    if (isWin) {
      // Extension membership already enforced by the PATHEXT permutation.
      return stats.isFile()
    }
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function uniqueDetectionDirectories(
  directories: string[],
  isWin: boolean,
  seen = new Set<string>()
): string[] {
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  return directories.filter((dir) => {
    const key = isWin ? path.normalize(dir).toLowerCase() : dir
    if (!isAbsolute(dir) || seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

type RecordDirectoryHit = (command: string, candidate: string) => void

export async function scanDetectionDirectories(
  directories: string[],
  options: {
    concurrency: number
    ordered: boolean
    scan: (dir: string, record: RecordDirectoryHit) => Promise<void>
    record: RecordDirectoryHit
    allFound: Promise<void>
    isDone: () => boolean
  }
): Promise<void> {
  if (directories.length === 0) {
    return
  }
  const { concurrency, ordered, scan, record, allFound, isDone } = options
  await scan(directories[0], record)
  if (!ordered) {
    await Promise.race([
      allFound,
      forEachWithConcurrency(directories.slice(1), concurrency, (dir) => scan(dir, record))
    ])
    return
  }
  // Listings overlap, but an earlier PATH entry wins even when a later stat finishes first.
  for (let index = 1; index < directories.length && !isDone(); index += concurrency) {
    const hits = await Promise.all(
      directories.slice(index, index + concurrency).map(async (dir) => {
        const matches = new Map<string, string>()
        await scan(dir, (command, candidate) => matches.set(command, candidate))
        return matches
      })
    )
    for (const matches of hits) {
      matches.forEach((candidate, command) => record(command, candidate))
    }
  }
}

export async function readDetectionDirectory(dir: string): Promise<Map<string, string> | null> {
  let directory: Dir
  try {
    directory = await opendir(dir, { bufferSize: MAX_DETECTION_DIRECTORY_ENTRIES + 1 })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return new Map()
    }
    // Searchable-but-unreadable directories still admit stat on known names.
    return null
  }
  try {
    const names = new Map<string, string>()
    let entries = 0
    for await (const entry of directory) {
      if (++entries > MAX_DETECTION_DIRECTORY_ENTRIES) {
        // Large directories cost less to probe by candidate than to enumerate in full.
        return null
      }
      if (/[^\p{ASCII}]/u.test(entry.name)) {
        // Filesystem Unicode equivalence can exceed JavaScript normalization and case folding.
        return null
      }
      names.set(directoryNameKey(entry.name), entry.name)
    }
    return names
  } catch {
    // A vanished entry during Dirent conversion cannot prove the directory empty.
    return null
  }
}
