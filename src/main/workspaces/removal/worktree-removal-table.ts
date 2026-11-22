import { WorktreeRemovalReservations } from './worktree-removal-reservations'
import { lstat } from 'node:fs/promises'
import { getErrorCode } from '../../git/worktrees/worktree-operation-options'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import {
  quarantineWorktreeRemovalJournal,
  readWorktreeRemovalJournal,
  writeWorktreeRemovalRecords,
  worktreeRemovalRecordsFile,
  type WorktreeRemovalJournalLoadResult,
  type WorktreeRemovalJournalQuarantineReason,
  type WorktreeRemovalRecord
} from './worktree-removal-records'
import { withSidecarSnapshotQueue } from '../../filesystem/sidecar-snapshot-file'

export type WorktreeRemovalJournalState =
  | { status: 'unloaded' }
  | { status: 'ready'; directory: string }
  | {
      status: 'degraded'
      directory: string
      file: string
      reason: WorktreeRemovalJournalQuarantineReason
      error?: unknown
    }

export const pendingWorktreeRemovals = new WorktreeRemovalReservations()
export const recordedWorktreeRemovals = new WeakSet<WorktreeRemovalRecord>()
// Failed leftovers stay visible until gone/replaced or their repo is removed; never retry without a request.
export const failedWorktreeRemovals = new Map<string, WorktreeRemovalRecord>()
// In-flight listings retain completed records only until their stale Git read is projected.
export const finishedWorktreeRemovals = new WeakSet<WorktreeRemovalRecord>()
type PendingJournalQuarantine = {
  file: string
  reason: WorktreeRemovalJournalQuarantineReason
  done: boolean
}
let journalState: WorktreeRemovalJournalState = { status: 'unloaded' }
let pendingQuarantine: PendingJournalQuarantine | null = null

export function getWorktreeRemovalJournalState(): WorktreeRemovalJournalState {
  return journalState
}

export function setWorktreeRemovalRecordsDirectory(directory: string | null): void {
  pendingQuarantine = null
  journalState = directory ? { status: 'ready', directory } : { status: 'unloaded' }
}

/** Read the journal before enabling writes; bad files stay flagged to move aside before replacing. */
export async function openWorktreeRemovalJournal(
  directory: string
): Promise<WorktreeRemovalJournalLoadResult> {
  const loaded = await readWorktreeRemovalJournal(directory)
  if (loaded.status === 'unavailable') {
    pendingQuarantine = { file: loaded.file, reason: loaded.reason, done: false }
    journalState = {
      status: 'degraded',
      directory,
      file: loaded.file,
      reason: loaded.reason,
      ...(loaded.error !== undefined ? { error: loaded.error } : {})
    }
    console.error(
      `[worktrees] worktree removal journal is unavailable (${loaded.reason}); will move ${loaded.file} aside before next write`,
      loaded.error
    )
    return loaded
  }
  if (loaded.status === 'partial') {
    pendingQuarantine = { file: loaded.file, reason: 'partial-entries', done: false }
    journalState = {
      status: 'degraded',
      directory,
      file: loaded.file,
      reason: 'partial-entries'
    }
    console.warn(
      `[worktrees] skipped ${loaded.droppedCount} malformed worktree removal journal entry(s); will move ${loaded.file} aside before next write`
    )
    return loaded
  }
  pendingQuarantine = null
  journalState = { status: 'ready', directory }
  return loaded
}

async function quarantineBeforeWrite(
  quarantine: PendingJournalQuarantine | null,
  directory: string
): Promise<void> {
  if (!quarantine || quarantine.done) {
    return
  }
  const moved = await quarantineWorktreeRemovalJournal(quarantine.file)
  quarantine.done = true
  if (moved) {
    console.warn(`[worktrees] moved ${quarantine.reason} worktree removal journal to ${moved}`)
  }
  if (pendingQuarantine === quarantine) {
    pendingQuarantine = null
    if (journalState.status === 'degraded' && journalState.directory === directory) {
      journalState = { status: 'ready', directory }
    }
  }
}

export function closeWorktreeRemovalRecords(): Promise<void> {
  const directory = journalState.status === 'unloaded' ? null : journalState.directory
  pendingQuarantine = null
  journalState = { status: 'unloaded' }
  return directory
    ? withSidecarSnapshotQueue(worktreeRemovalRecordsFile(directory), async () => {})
    : Promise.resolve()
}

export function persistWorktreeRemovalRecords(): Promise<void> {
  if (journalState.status === 'unloaded') {
    return Promise.resolve()
  }
  if (
    journalState.status === 'degraded' &&
    journalState.reason !== 'partial-entries' &&
    journalRecords().length === 0
  ) {
    return Promise.resolve()
  }
  const directory = journalState.directory
  const quarantine = pendingQuarantine
  return writeWorktreeRemovalRecords(directory, journalRecords, undefined, {
    beforeWrite: () => quarantineBeforeWrite(quarantine, directory)
  }).catch((error: unknown) => {
    console.warn('[worktrees] failed to persist worktree removal records', error)
  })
}

function journalRecords(candidate?: WorktreeRemovalRecord): WorktreeRemovalRecord[] {
  const records = new Map(failedWorktreeRemovals)
  for (const record of pendingWorktreeRemovals.values()) {
    if (recordedWorktreeRemovals.has(record)) {
      records.set(record.worktreeId, record)
    }
  }
  if (candidate) {
    records.set(candidate.worktreeId, candidate)
  }
  return [...records.values()]
}

/** Commit only this admission; unrelated reservations must never reach a restart's journal. */
export function recordWorktreeRemoval(record: WorktreeRemovalRecord): Promise<void> {
  if (journalState.status === 'unloaded') {
    return Promise.reject(
      new Error('Could not start deletion. Reopen the workspace and try again.')
    )
  }
  const directory = journalState.directory
  const quarantine = pendingQuarantine
  return writeWorktreeRemovalRecords(
    directory,
    () => journalRecords(record),
    () => {
      recordedWorktreeRemovals.add(record)
      failedWorktreeRemovals.delete(record.worktreeId)
    },
    { beforeWrite: () => quarantineBeforeWrite(quarantine, directory) }
  )
}

/** Unreadable counts as present: only a checkout proven gone ends a failed delete. */
export async function worktreeCheckoutExists(worktreePath: string): Promise<boolean> {
  try {
    await lstat(worktreePath)
    return true
  } catch (error) {
    const code = getErrorCode(error)
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

export function hasPendingWorktreeRemovals(): boolean {
  return pendingWorktreeRemovals.size > 0
}

export function findPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): WorktreeRemovalRecord | undefined {
  const branch = target.branch?.replace(/^refs\/heads\//, '')
  for (const removal of [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()]) {
    if (!areWorktreePathsEqual(removal.repoPath, repoPath)) {
      continue
    }
    if (
      (target.worktreePath && areWorktreePathsEqual(removal.worktreePath, target.worktreePath)) ||
      (branch && removal.branch === branch)
    ) {
      return removal
    }
  }
  return undefined
}

export function assertNoPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): void {
  const removal = findPendingWorktreeRemovalConflict(repoPath, target)
  if (removal) {
    throw new Error(
      removal.failure
        ? `Cleanup failed for the workspace at ${removal.worktreePath}. Retry deleting it before reusing its path or branch.`
        : `Orca is still deleting the workspace at ${removal.worktreePath}. Cleanup is pending; try again shortly.`
    )
  }
}
