import {
  opendirSync,
  readdir as readdirCallback,
  readdirSync,
  type Dir,
  type Dirent
} from 'node:fs'
import { lstat, opendir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
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
    return null
  }
}

function isDirentLookupError(error: unknown): error is { syscall: 'lstat'; code?: unknown } {
  return !!error && typeof error === 'object' && 'syscall' in error && error.syscall === 'lstat'
}

// The callback API resolves DT_UNKNOWN entries with async lstat.
const readdirEntries = promisify<string, { withFileTypes: true }, Dirent[]>(readdirCallback)

export async function readInlineInstallSubdirectories(
  dir: string
): Promise<InstallDirectoryListing> {
  const names: string[] = []
  let uncertain = false
  try {
    const entries = await readdirEntries(dir, { withFileTypes: true })
    return {
      names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      uncertain
    }
  } catch (error) {
    if (!isDirentLookupError(error)) {
      return { names, uncertain: !isMissingPathError(error) && !isPathPermissionError(error) }
    }
    uncertain = !isMissingPathError(error)
  }
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

export function readInstallSubdirectories(dir: string): InstallDirectoryListing {
  const names: string[] = []
  let uncertain = false
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        names.push(entry.name)
      }
    }
    return { names, uncertain }
  } catch (error) {
    if (!isDirentLookupError(error)) {
      return { names, uncertain: !isMissingPathError(error) && !isPathPermissionError(error) }
    }
    uncertain = error.code !== 'ENOENT'
  }
  try {
    // Read one entry at a time so a DT_UNKNOWN lookup error only drops that entry.
    using directory = opendirSync(dir, { bufferSize: 1 })
    for (;;) {
      try {
        const entry = directory.readSync()
        if (!entry) {
          return { names, uncertain }
        }
        if (entry.isDirectory()) {
          names.push(entry.name)
        }
      } catch (error) {
        if (!isDirentLookupError(error)) {
          throw error
        }
        uncertain ||= error.code !== 'ENOENT'
      }
    }
  } catch (error) {
    return {
      names,
      uncertain: uncertain || (!isMissingPathError(error) && !isPathPermissionError(error))
    }
  }
}
