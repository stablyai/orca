/**
 * Partition folders whose session this run loaded. Windows keeps a loaded session's files open, so
 * deleting the folder then fails half-way (EBUSY); it is deleted on the next start instead, before
 * any session loads. The session's data is already cleared through Chromium when it is queued.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'

const PENDING_DELETES_FILE_NAME = 'browser-route-partition-pending-deletes.json'

// Why per profile: Partitions is shared across Orca profiles but bindings are not, so only the
// profile that queued a folder can tell whether it was bound again.
export function browserRoutePartitionPendingDeletesPath(bindingFilePath: string): string {
  return join(dirname(bindingFilePath), PENDING_DELETES_FILE_NAME)
}

/** Comparison key for a partition folder: resolved, and case-folded for Windows paths. */
export function browserRoutePartitionDirectoryKey(
  directory: string,
  resolvePath: (path: string) => string = resolve
): string {
  return normalizeRuntimePathForComparison(resolvePath(directory))
}

function isStrictlyInside(
  partitionDataRoot: string,
  directory: string,
  resolvePath: (path: string) => string
): boolean {
  const relative = relativePathInsideRoot(resolvePath(partitionDataRoot), resolvePath(directory))
  return relative !== null && relative !== ''
}

function readPending(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
  } catch {
    // A corrupt list only costs a folder that stays until a later removal queues it again.
    return []
  }
}

function writePending(filePath: string, directories: readonly string[]): void {
  const temp = `${filePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify([...new Set(directories)])}\n`)
  renameSync(temp, filePath)
}

export function queueBrowserRoutePartitionDirectoryDelete(
  filePath: string,
  directory: string
): void {
  writePending(filePath, [...readPending(filePath), directory])
}

/** Startup, before sessions load. A folder bound again since it was queued is kept: it is in use. */
export async function deletePendingBrowserRoutePartitionDirectories(input: {
  filePath: string
  partitionDataRoot: string
  isBound: (directory: string) => boolean
  removeDirectory: (directory: string) => Promise<void>
  resolvePath?: (path: string) => string
}): Promise<unknown[]> {
  const pending = readPending(input.filePath)
  if (pending.length === 0) {
    return []
  }
  const resolvePath = input.resolvePath ?? resolve
  const failures: unknown[] = []
  const kept: string[] = []
  for (const directory of pending) {
    // Why: the list is a file on disk; a recursive delete must never reach outside Partitions.
    if (!isStrictlyInside(input.partitionDataRoot, directory, resolvePath)) {
      continue
    }
    if (input.isBound(directory)) {
      continue
    }
    try {
      await input.removeDirectory(directory)
    } catch (error) {
      failures.push(error)
      kept.push(directory)
    }
  }
  // Keep folders queued while a delete above was awaiting.
  const processed = new Set(pending)
  writePending(input.filePath, [
    ...kept,
    ...readPending(input.filePath).filter((directory) => !processed.has(directory))
  ])
  return failures
}
