// The sidecar persists before deletion without waiting for batched profile writes or entering profile exports.
import { renameDurable } from '../../filesystem/durable-file-write'
import {
  readSidecarSnapshotResult,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../../filesystem/sidecar-snapshot-file'

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
  /** Admin entry the checkout's `.git` file named when accepted; a leftover naming another is not this checkout. */
  gitdir?: string
  deleteBranch: boolean
  force: boolean
  requestedAt: number
  /** Cleanup failed; files, Git ownership or metadata may still need an explicit retry. */
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
    ...(typeof value.gitdir === 'string' && value.gitdir ? { gitdir: value.gitdir } : {}),
    ...(failure ? { failure } : {})
  }
}

export type WorktreeRemovalJournalUnavailableReason =
  | 'unreadable'
  | 'malformed'
  | 'unsupported-version'

export type WorktreeRemovalJournalQuarantineReason =
  | WorktreeRemovalJournalUnavailableReason
  | 'partial-entries'

export type WorktreeRemovalJournalLoadResult =
  | { status: 'ok'; records: WorktreeRemovalRecord[] }
  | { status: 'missing'; records: [] }
  | { status: 'partial'; records: WorktreeRemovalRecord[]; droppedCount: number; file: string }
  | {
      status: 'unavailable'
      reason: WorktreeRemovalJournalUnavailableReason
      file: string
      error?: unknown
    }

let lastQuarantineTimestamp = 0

export function worktreeRemovalRecordsFile(directory: string): string {
  return sidecarSnapshotFile(directory, RECORDS_FILE_NAME)
}

/** Rename a bad or unreadable journal aside before overwriting it; returns null when already absent. */
export async function quarantineWorktreeRemovalJournal(file: string): Promise<string | null> {
  const timestamp = Math.max(Date.now(), lastQuarantineTimestamp + 1)
  lastQuarantineTimestamp = timestamp
  const target = `${file}.corrupt-${timestamp}`
  try {
    await renameDurable(file, target)
    return target
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

export async function readWorktreeRemovalJournal(
  directory: string
): Promise<WorktreeRemovalJournalLoadResult> {
  const file = worktreeRemovalRecordsFile(directory)
  const snapshot = await readSidecarSnapshotResult(file)
  if (snapshot.status === 'missing') {
    return { status: 'missing', records: [] }
  }
  if (snapshot.status === 'unreadable' || snapshot.status === 'malformed') {
    return { status: 'unavailable', reason: snapshot.status, file, error: snapshot.error }
  }
  const parsed = snapshot.value
  if (!isRecord(parsed)) {
    return { status: 'unavailable', reason: 'malformed', file }
  }
  if (typeof parsed.version === 'number' && parsed.version !== RECORDS_VERSION) {
    return { status: 'unavailable', reason: 'unsupported-version', file }
  }
  if (parsed.version !== RECORDS_VERSION || !Array.isArray(parsed.removals)) {
    return { status: 'unavailable', reason: 'malformed', file }
  }
  const records: WorktreeRemovalRecord[] = []
  let droppedCount = 0
  for (const entry of parsed.removals) {
    const record = parseRecord(entry)
    if (record) {
      records.push(record)
    } else {
      droppedCount += 1
    }
  }
  return droppedCount > 0
    ? { status: 'partial', records, droppedCount, file }
    : { status: 'ok', records }
}

export async function readWorktreeRemovalRecords(
  directory: string
): Promise<WorktreeRemovalRecord[]> {
  const result = await readWorktreeRemovalJournal(directory)
  return result.status === 'ok' || result.status === 'partial' ? result.records : []
}

/** Read current records when the queued write runs so newer state wins. */
export function writeWorktreeRemovalRecords(
  directory: string,
  current: () => WorktreeRemovalRecord[],
  committed?: () => void,
  options?: { beforeWrite?: () => Promise<void> }
): Promise<void> {
  const file = worktreeRemovalRecordsFile(directory)
  return withSidecarSnapshotQueue(file, async () => {
    await options?.beforeWrite?.()
    await writeSidecarSnapshot(file, {
      version: RECORDS_VERSION,
      removals: current()
    } satisfies PersistedWorktreeRemovalRecords)
    committed?.()
  })
}
