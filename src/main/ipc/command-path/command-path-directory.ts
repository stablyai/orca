import type { Dir, Dirent } from 'node:fs'
import { lstat, opendir, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  isMissingPathError,
  isPathPermissionError,
  probeExecutableFile,
  UNVERIFIED_FS_PROBE,
  type InstallDirectoryListing,
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

export async function readDetectionDirectory(dir: string): Promise<DetectionDirectoryListing> {
  let directory: Dir | Dirent[]
  try {
    // Windows opendir can report a failed open as success with no handle and crash; readdir reports it (#50875).
    directory =
      process.platform === 'win32'
        ? await readdir(dir, { withFileTypes: true })
        : await opendir(dir, { bufferSize: MAX_DETECTION_DIRECTORY_ENTRIES + 1 })
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
    return null
  }
}

function isDirentLookupError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'syscall' in error && error.syscall === 'lstat'
}

export async function readInstallSubdirectories(
  dir: string,
  mode: 'worker' | 'cli' = 'worker'
): Promise<InstallDirectoryListing> {
  const names: string[] = []
  try {
    if (mode === 'cli') {
      // Node's DT_UNKNOWN lstats use the isolated CLI child's own libuv pool.
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          names.push(entry.name)
        }
      }
      return { names, uncertain: false }
    }
    // Node resolves DT_UNKNOWN sequentially on the worker, outside the libuv pool.
    for await (const entry of await opendir(dir)) {
      if (entry.isDirectory()) {
        names.push(entry.name)
      }
    }
    return { names, uncertain: false }
  } catch (error) {
    if (isDirentLookupError(error)) {
      return readInstallSubdirectoriesByName(dir, !isMissingPathError(error))
    }
    return { names: [], uncertain: !isMissingPathError(error) && !isPathPermissionError(error) }
  }
}

export async function readInstallSubdirectoriesByName(
  dir: string,
  uncertain = false
): Promise<InstallDirectoryListing> {
  const names: string[] = []
  try {
    for (const name of await readdir(dir)) {
      try {
        if ((await lstat(path.join(dir, name))).isDirectory()) {
          names.push(name)
        }
      } catch (error) {
        uncertain ||= !isMissingPathError(error)
      }
    }
  } catch (error) {
    uncertain ||= !isMissingPathError(error) && !isPathPermissionError(error)
  }
  return { names, uncertain }
}
