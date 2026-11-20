// Proof that Orca itself deleted a workspace folder: the chat history sweep deletes nothing without it.
import { lstat, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../../../filesystem/sidecar-snapshot-file'
import { isPathAbsentError } from '../../../filesystem/local-file-io/filesystem-path-containment'

const RECORDS_FILE_NAME = 'orca-deleted-workspace-folders.json'
const RECORDS_VERSION = 1
// Dropping the oldest only stops sweeping them, never deletes more.
const MAX_RECORDS = 5000

/** One folder Orca deleted: chats started in it after `createdAt` and last active by `deletedAt` were its own. */
export type DeletedWorkspaceFolderRecord = {
  path: string
  /** The parent folder's filesystem identity when the folder was deleted. */
  parentId: string
  /** The folder's own name, byte-exact. */
  name: string
  createdAt: number
  deletedAt: number
}

export type WorkspaceFolderBeforeDeletion = Omit<DeletedWorkspaceFolderRecord, 'deletedAt'>

function recordsFile(directory: string): string {
  return sidecarSnapshotFile(directory, RECORDS_FILE_NAME)
}

// Bigint: NTFS file ids exceed 2^53 and would round together; inode 0 means no identity.
export async function folderIdentityOf(path: string): Promise<string | null> {
  return stat(path, { bigint: true }).then(
    (stats) => (stats.isDirectory() && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : null),
    () => null
  )
}

/** Read before deletion: null unless the path is a real folder (not a link) with a provable parent. */
export async function readWorkspaceFolderBeforeDeletion(
  path: string
): Promise<WorkspaceFolderBeforeDeletion | null> {
  // Without trailing separators: `/a/b/` and `/a/b` name one folder.
  const trimmed = path.replace(/[\\/]+$/, '')
  const name = basename(trimmed)
  const parent = dirname(trimmed)
  const stats = await lstat(trimmed).catch(() => null)
  if (!name || parent === trimmed || !stats?.isDirectory()) {
    return null
  }
  const parentId = await folderIdentityOf(parent)
  // Some filesystems report no birth time: the last status change comes later, so it keeps more.
  const createdAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs
  return parentId && createdAt > 0 ? { path: trimmed, parentId, name, createdAt } : null
}

function parseRecord(value: unknown): DeletedWorkspaceFolderRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { path, parentId, name, createdAt, deletedAt } = value as Record<string, unknown>
  return typeof path === 'string' &&
    typeof parentId === 'string' &&
    typeof name === 'string' &&
    name.length > 0 &&
    typeof createdAt === 'number' &&
    typeof deletedAt === 'number' &&
    Number.isFinite(createdAt) &&
    Number.isFinite(deletedAt) &&
    createdAt <= deletedAt
    ? { path, parentId, name, createdAt, deletedAt }
    : null
}

async function readRecordsFile(directory: string): Promise<DeletedWorkspaceFolderRecord[]> {
  const parsed = (await readSidecarSnapshot(recordsFile(directory))) as {
    version?: unknown
    folders?: unknown
  } | null
  // Another format (older, newer or damaged) reads as no records: nothing is proven Orca's.
  if (parsed?.version !== RECORDS_VERSION || !Array.isArray(parsed.folders)) {
    return []
  }
  return parsed.folders.flatMap((entry) => parseRecord(entry) ?? [])
}

function updateRecords(
  directory: string,
  update: (
    records: DeletedWorkspaceFolderRecord[]
  ) => Promise<DeletedWorkspaceFolderRecord[] | null>
): Promise<DeletedWorkspaceFolderRecord[]> {
  const file = recordsFile(directory)
  return withSidecarSnapshotQueue(file, async () => {
    const records = await readRecordsFile(directory)
    const next = await update(records)
    if (next === null) {
      return records
    }
    const kept = next.slice(-MAX_RECORDS)
    await writeSidecarSnapshot(file, { version: RECORDS_VERSION, folders: kept })
    return kept
  })
}

/** Called once Orca has deleted the folder read by `readWorkspaceFolderBeforeDeletion`. */
export function recordDeletedWorkspaceFolder(
  directory: string,
  folder: WorkspaceFolderBeforeDeletion,
  deletedAt = Date.now()
): Promise<void> {
  return updateRecords(directory, async (records) => {
    // Only a folder proven gone was deleted; a failed or partial delete leaves no proof.
    const gone = await lstat(folder.path).then(
      () => false,
      (error: unknown) => isPathAbsentError(error)
    )
    return gone && folder.createdAt <= deletedAt ? [...records, { ...folder, deletedAt }] : null
  }).then(
    () => undefined,
    (error: unknown) => {
      // A lost record only keeps that workspace's chats; it must not fail the removal.
      console.warn('[workspace-cleanup] Could not record a deleted workspace folder', error)
    }
  )
}

/**
 * The records that still describe a deleted folder. A record whose path exists again, or whose
 * parent is now a different folder, no longer proves anything and is dropped for good; one that
 * can't be checked right now (unreadable, parent unmounted) is kept but not used.
 */
export async function readDeletedWorkspaceFolderRecords(
  directory: string
): Promise<DeletedWorkspaceFolderRecord[]> {
  const usable: DeletedWorkspaceFolderRecord[] = []
  await updateRecords(directory, async (records) => {
    const kept: DeletedWorkspaceFolderRecord[] = []
    for (const record of records) {
      const present = await lstat(record.path).then(
        () => true,
        (error: unknown) => (isPathAbsentError(error) ? false : null)
      )
      if (present === true) {
        continue
      }
      const parentId = present === false ? await folderIdentityOf(dirname(record.path)) : null
      if (parentId !== null && parentId !== record.parentId) {
        continue
      }
      kept.push(record)
      if (parentId === record.parentId) {
        usable.push(record)
      }
    }
    return kept.length === records.length ? null : kept
  })
  return usable
}

/** The record for this byte-exact folder whose lifetime holds a chat started at `startedAt`. */
export function deletedFolderGeneration(
  records: readonly DeletedWorkspaceFolderRecord[],
  parentId: string,
  name: string,
  startedAt: number | null
): DeletedWorkspaceFolderRecord | null {
  if (startedAt === null || !Number.isFinite(startedAt)) {
    return null
  }
  let match: DeletedWorkspaceFolderRecord | null = null
  for (const record of records) {
    if (
      record.parentId === parentId &&
      record.name === name &&
      record.createdAt <= startedAt &&
      startedAt <= record.deletedAt &&
      (!match || record.createdAt > match.createdAt)
    ) {
      match = record
    }
  }
  return match
}
