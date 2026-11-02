// The sidecar persists before deletion without waiting for batched profile writes or entering profile exports.
import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from './sidecar-snapshot-file'

const RECORDS_FILE_NAME = 'orca-worktree-removals.json'
const RECORDS_VERSION = 1

/** Accepted choices needed to resume this host's removal after a restart. */
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
  /** Git dropped registration; branch/remote cleanup ran, but the folder remains. */
  failure?: WorktreeRemovalFailure
}

export type WorktreeRemovalFailure = {
  message: string
  failedAt: number
}

type PersistedWorktreeRemovalRecords = {
  version: number
  removals: WorktreeRemovalRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFailure(value: unknown): WorktreeRemovalFailure | null | undefined {
  if (value === undefined) {
    return undefined
  }
  return isRecord(value) && typeof value.message === 'string' && typeof value.failedAt === 'number'
    ? { message: value.message, failedAt: value.failedAt }
    : null
}

function parseRecord(value: unknown): WorktreeRemovalRecord | null {
  const failure = isRecord(value) ? parseFailure(value.failure) : null
  if (
    failure === null ||
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
    requestedAt: value.requestedAt,
    ...(failure ? { failure } : {})
  }
}

export function worktreeRemovalRecordsFile(directory: string): string {
  return sidecarSnapshotFile(directory, RECORDS_FILE_NAME)
}

export async function readWorktreeRemovalRecords(
  directory: string
): Promise<WorktreeRemovalRecord[]> {
  const parsed = await readSidecarSnapshot(worktreeRemovalRecordsFile(directory))
  if (!isRecord(parsed) || parsed.version !== RECORDS_VERSION || !Array.isArray(parsed.removals)) {
    return []
  }
  return parsed.removals.flatMap((entry) => parseRecord(entry) ?? [])
}

/** Read current records when the queued write runs so newer state wins. */
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
