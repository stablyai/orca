import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createMobileFileDirectoryLimitState,
  trackMobileFileDirectoryEntry
} from '../shared/mobile-file-directory-limit'

type RelayDirectorySourceEntry = {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type RelayDirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

const MOBILE_DIRECTORY_STAT_CONCURRENCY = 32

export async function isRelayDirectoryEntry(
  dirPath: string,
  entry: RelayDirectorySourceEntry
): Promise<boolean> {
  if (entry.isDirectory()) {
    return true
  }
  if (!entry.isSymbolicLink()) {
    return false
  }
  try {
    // Why: linked workspace directories must remain expandable in the file explorer.
    return (await stat(join(dirPath, entry.name))).isDirectory()
  } catch {
    return false
  }
}

export async function readMobileRelayDirectory(dirPath: string): Promise<RelayDirectoryEntry[]> {
  return collectMobileRelayDirectoryEntries(dirPath, await opendir(dirPath))
}

export async function collectMobileRelayDirectoryEntries(
  dirPath: string,
  directory: AsyncIterable<RelayDirectorySourceEntry>
): Promise<RelayDirectoryEntry[]> {
  const entries: RelayDirectoryEntry[] = []
  let batch: RelayDirectorySourceEntry[] = []
  const limit = createMobileFileDirectoryLimitState()

  const flushBatch = async (): Promise<void> => {
    entries.push(
      ...(await Promise.all(
        batch.map(async (entry) => ({
          name: entry.name,
          isDirectory: await isRelayDirectoryEntry(dirPath, entry),
          isSymlink: entry.isSymbolicLink()
        }))
      ))
    )
    batch = []
  }

  for await (const entry of directory) {
    trackMobileFileDirectoryEntry(limit, entry)
    batch.push(entry)
    if (batch.length === MOBILE_DIRECTORY_STAT_CONCURRENCY) {
      await flushBatch()
    }
  }
  if (batch.length > 0) {
    await flushBatch()
  }
  return entries
}
