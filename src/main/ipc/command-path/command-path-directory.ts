import type { Dir } from 'node:fs'
import { opendir, readdir } from 'node:fs/promises'

const MAX_DETECTION_DIRECTORY_ENTRIES = 128

export function directoryNameKey(name: string): string {
  return name.normalize('NFD').toLowerCase()
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

/** Names-only in-process listing: no Dirent conversion, so no synchronous lstat probing on the caller's thread. */
export async function readDetectionDirectoryNames(
  dir: string
): Promise<Map<string, string> | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return new Map()
    }
    // Unreadable now: candidate probing still works, it only costs more.
    return null
  }
  if (names.length > MAX_DETECTION_DIRECTORY_ENTRIES) {
    return null
  }
  const keyed = new Map<string, string>()
  for (const name of names) {
    if (/[^\p{ASCII}]/u.test(name)) {
      return null
    }
    keyed.set(directoryNameKey(name), name)
  }
  return keyed
}
