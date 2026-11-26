import type { Dir, Stats } from 'node:fs'
import { access, constants as fsConstants, opendir, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_DETECTION_DIRECTORY_ENTRIES = 128

export function directoryNameKey(name: string): string {
  return name.normalize('NFD').toLowerCase()
}

export async function isExecutableFile(candidate: string, isWin: boolean): Promise<boolean> {
  return (await checkExecutableFile(candidate, isWin)) === 'executable'
}

export async function checkExecutableFile(
  candidate: string,
  isWin: boolean
): Promise<'executable' | 'missing' | 'unknown'> {
  let stats: Stats
  try {
    // Follow symlinked CLIs to their real targets.
    stats = await stat(candidate)
  } catch (error) {
    return isMissingPathError(error) ? 'missing' : 'unknown'
  }
  if (stats.isDirectory()) {
    // PATH directories are not executable files despite their search bit.
    return 'missing'
  }
  if (isWin) {
    // Extension membership already enforced by the PATHEXT permutation.
    return stats.isFile() ? 'executable' : 'missing'
  }
  try {
    await access(candidate, fsConstants.X_OK)
    return 'executable'
  } catch (error) {
    return isMissingPathError(error, true) ? 'missing' : 'unknown'
  }
}

function isMissingPathError(error: unknown, checkedFile = false): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      (checkedFile && (error.code === 'EACCES' || error.code === 'EPERM')))
  )
}

export function detectionDirectoryKey(dir: string, isWin: boolean): string {
  return isWin
    ? path.win32
        .normalize(dir)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    : dir
}

export async function scanDetectionDirectories<T, Hit>(
  directories: T[],
  concurrency: number,
  scan: (dir: T) => Promise<Hit>,
  commit: (dir: T, hits: Hit) => void,
  isDone: () => boolean
): Promise<void> {
  // Start the first entry on its own. Later reads overlap, but commit strictly in PATH order.
  if (directories.length === 0) {
    return
  }
  commit(directories[0], await scan(directories[0]))
  for (let index = 1; index < directories.length && !isDone(); index += concurrency) {
    const wave = directories.slice(index, index + concurrency)
    const pending = wave.map((dir) => scan(dir))
    for (const [offset, dir] of wave.entries()) {
      commit(dir, await pending[offset])
      if (isDone()) {
        return
      }
    }
  }
}

export async function readDetectionDirectory(dir: string): Promise<Map<string, string> | null> {
  let directory: Dir
  try {
    directory = await opendir(dir, { bufferSize: MAX_DETECTION_DIRECTORY_ENTRIES + 1 })
  } catch (error) {
    if (isMissingPathError(error)) {
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
