// Why a sidecar beside the profile state: the record must be on disk before Git starts deleting,
// and profile-state writes are batched; the sidecar writer fsyncs and renames atomically. It also
// keeps a host-local, in-flight obligation out of profile exports and backups.
import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from './sidecar-snapshot-file'

const RECORDS_FILE_NAME = 'orca-worktree-removals.json'
const RECORDS_VERSION = 1

/** A local worktree removal Orca accepted; everything a restart needs to run the same delete. */
export type WorktreeRemovalRecord = {
  worktreeId: string
  repoId: string
  repoPath: string
  worktreePath: string
  /** Short branch name the checkout had; empty when detached. */
  branch: string
  /** Branch head when the removal was accepted; empty when unknown. */
  head: string
  deleteBranch: boolean
  force: boolean
  requestedAt: number
}

type PersistedWorktreeRemovalRecords = {
  version: number
  removals: WorktreeRemovalRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(value: unknown): WorktreeRemovalRecord | null {
  if (
    !isRecord(value) ||
    typeof value.worktreeId !== 'string' ||
    typeof value.repoId !== 'string' ||
    typeof value.repoPath !== 'string' ||
    typeof value.worktreePath !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.head !== 'string' ||
    typeof value.deleteBranch !== 'boolean' ||
    typeof value.force !== 'boolean' ||
    typeof value.requestedAt !== 'number'
  ) {
    return null
  }
  return {
    worktreeId: value.worktreeId,
    repoId: value.repoId,
    repoPath: value.repoPath,
    worktreePath: value.worktreePath,
    branch: value.branch,
    head: value.head,
    deleteBranch: value.deleteBranch,
    force: value.force,
    requestedAt: value.requestedAt
  }
}

export function worktreeRemovalRecordsFile(directory: string): string {
  return sidecarSnapshotFile(directory, RECORDS_FILE_NAME)
}

/** Records a previous run left behind; a missing or unreadable file reads as none. */
export async function readWorktreeRemovalRecords(
  directory: string
): Promise<WorktreeRemovalRecord[]> {
  const parsed = await readSidecarSnapshot(worktreeRemovalRecordsFile(directory))
  if (!isRecord(parsed) || parsed.version !== RECORDS_VERSION || !Array.isArray(parsed.removals)) {
    return []
  }
  return parsed.removals.flatMap((entry) => parseRecord(entry) ?? [])
}

/** Writes the current records; `current` is read when the queued write runs, so the latest wins. */
export function writeWorktreeRemovalRecords(
  directory: string,
  current: () => WorktreeRemovalRecord[]
): Promise<void> {
  const file = worktreeRemovalRecordsFile(directory)
  return withSidecarSnapshotQueue(file, () =>
    writeSidecarSnapshot(file, {
      version: RECORDS_VERSION,
      removals: current()
    } satisfies PersistedWorktreeRemovalRecords)
  )
}
