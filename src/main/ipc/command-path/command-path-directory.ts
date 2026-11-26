import { opendirSync, readdirSync, type Dir } from 'node:fs'
import { opendir } from 'node:fs/promises'
import path from 'node:path'
import {
  isMissingPathError,
  isPathPermissionError,
  probeExecutableFile,
  UNVERIFIED_FS_PROBE,
  type InventoryFsProbes
} from '../../../shared/shell/command-resolution/inventory-fs-probes'
import type { DetectionDirectoryListing } from './command-path-directory-worker-protocol'

const MAX_DETECTION_DIRECTORY_ENTRIES = 128

export function directoryNameKey(name: string): string {
  return name.normalize('NFD').toLowerCase()
}

export async function isExecutableFile(candidate: string, isWin: boolean): Promise<boolean> {
  return (await checkExecutableFile(candidate, isWin)) === 'executable'
}

export async function checkExecutableFile(
  candidate: string,
  isWin: boolean,
  probes?: InventoryFsProbes
): Promise<'executable' | 'missing' | 'unknown'> {
  const result = await (probes
    ? probes.executableFile(candidate, isWin)
    : probeExecutableFile(candidate, isWin))
  return result === UNVERIFIED_FS_PROBE ? 'unknown' : result ? 'executable' : 'missing'
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

export async function readDetectionDirectory(
  dir: string,
  inventory = false
): Promise<DetectionDirectoryListing> {
  let directory: Dir
  try {
    directory = await opendir(dir, { bufferSize: MAX_DETECTION_DIRECTORY_ENTRIES + 1 })
  } catch (error) {
    if (isMissingPathError(error)) {
      return new Map()
    }
    // Searchable-but-unreadable directories still admit stat on known names.
    return !inventory || isPathPermissionError(error) ? null : 'unverified'
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
  } catch (error) {
    return !inventory || isDirentLookupError(error) || isPathPermissionError(error)
      ? null
      : 'unverified'
  }
}

function isDirentLookupError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'syscall' in error && error.syscall === 'lstat'
}

export function readInstallSubdirectories(dir: string): DetectionDirectoryListing {
  const names = new Map<string, string>()
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        names.set(entry.name, entry.name)
      }
    }
    return names
  } catch (error) {
    if (!isDirentLookupError(error)) {
      return isMissingPathError(error) || isPathPermissionError(error) ? names : 'unverified'
    }
  }
  try {
    // Read one entry at a time so a DT_UNKNOWN lookup error only drops that entry.
    using directory = opendirSync(dir, { bufferSize: 1 })
    for (;;) {
      try {
        const entry = directory.readSync()
        if (!entry) {
          return names
        }
        if (entry.isDirectory()) {
          names.set(entry.name, entry.name)
        }
      } catch (error) {
        if (!isDirentLookupError(error)) {
          throw error
        }
      }
    }
  } catch (error) {
    return names.size || isMissingPathError(error) || isPathPermissionError(error)
      ? names
      : 'unverified'
  }
}
