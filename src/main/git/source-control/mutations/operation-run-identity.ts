import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import {
  OPERATION_RUN_CHANGED_ERROR,
  type GitConflictOperation
} from '../../../../shared/git/status/git-status-types'
import type { GitRuntimeOptions } from '../../command-runner/git-runtime-options'
import { resolveGitDir } from '../resolve-git-dir'

/** Which rebase directory exists and its inode/birth time; null when no rebase is in progress. */
export async function readRebaseDirIdentity(gitDir: string): Promise<string | null> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const info = await stat(path.join(gitDir, dir), { bigint: true })
      // Never ctime: Git adds and removes files in this dir on every step. Birth time is 0 where
      // the filesystem lacks it, leaving the inode alone to tell runs apart.
      return `${dir}:${info.ino}:${info.birthtimeNs}`
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
}

const MARKER_FILES = {
  merge: 'MERGE_HEAD',
  'cherry-pick': 'CHERRY_PICK_HEAD',
  revert: 'REVERT_HEAD'
} as const

const NS_PER_SECOND = 1_000_000_000n

/**
 * Without a birth time and with whole-second timestamps (FAT, some network mounts), a rewritten
 * marker can repeat an earlier reading exactly, so the reading can't tell two runs apart.
 */
function isWeakReading(birthtimeNs: bigint, ...timesNs: bigint[]): boolean {
  return birthtimeNs === 0n && timesNs.every((time) => time % NS_PER_SECOND === 0n)
}

/**
 * A best-effort reading of which paused run this is. Git writes the marker (MERGE_HEAD,
 * CHERRY_PICK_HEAD, REVERT_HEAD) or rebase directory again when a run starts, so a new run at the
 * same HEAD normally reads differently. Nothing guarantees it: a filesystem can reuse an inode
 * with equal timestamps, and a chmod or touch within one run changes it (a false refusal, not an
 * unsafe abort). A weak reading counts as unreadable. Null means unreadable; callers must then
 * not bind a confirmation to it.
 */
export async function readOperationRunIdentity(
  worktreePath: string,
  operation: GitConflictOperation,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<string | null> {
  if (operation === 'unknown') {
    return null
  }
  const gitDir = await resolveGitDir(worktreePath, options)
  if (operation === 'rebase') {
    // The dir's own times change on every step, so only its inode and birth time identify a run.
    const identity = await readRebaseDirIdentity(gitDir)
    return identity && !identity.endsWith(':0') ? identity : null
  }
  const marker = MARKER_FILES[operation]
  try {
    return markerIdentity(marker, await stat(path.join(gitDir, marker), { bigint: true }))
  } catch {
    return null
  }
}

type MarkerStat = Pick<BigIntStats, 'ino' | 'birthtimeNs' | 'ctimeNs' | 'mtimeNs'>

/** The identity of one marker file reading, or null when the reading is too weak to use. */
export function markerIdentity(marker: string, info: MarkerStat): string | null {
  if (isWeakReading(info.birthtimeNs, info.mtimeNs, info.ctimeNs)) {
    return null
  }
  return `${marker}:${info.ino}:${info.birthtimeNs}:${info.ctimeNs}:${info.mtimeNs}`
}

/**
 * Refuses an abort the user confirmed for an earlier run: the confirmation was bound to the
 * identity Source Control showed, and a different (or unreadable) one means the run changed.
 * Residual: Orca's locks serialize Orca's own Git work only, so a process outside Orca can still
 * swap runs between this check and Git starting the abort. That interval is usually short but
 * not bounded: routing, environment setup and subprocess admission can queue before Git starts.
 */
export async function assertOperationRunIdentity(
  worktreePath: string,
  operation: Exclude<GitConflictOperation, 'unknown'>,
  expectedRunIdentity: string | undefined,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<void> {
  if (expectedRunIdentity === undefined) {
    return
  }
  const current = await readOperationRunIdentity(worktreePath, operation, options)
  if (current !== expectedRunIdentity) {
    throw new Error(
      `${OPERATION_RUN_CHANGED_ERROR}: The ${operation} changed after Abort was chosen, so nothing was aborted.`
    )
  }
}

/**
 * Confirms a reading taken before a status snapshot is still current after it; null when it
 * changed or can't be re-read. With the first reading taken before the snapshot starts, a
 * snapshot can't pair one run's view with another run's identity, as far as readings differ.
 */
export async function readStableRunIdentity(
  earlier: string | null,
  readAgain: () => Promise<string | null>
): Promise<string | null> {
  if (earlier === null) {
    return null
  }
  const now = await readAgain().catch(() => null)
  return now === earlier ? earlier : null
}
