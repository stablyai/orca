import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGitdirMarkerPayload } from '../../../shared/git/metadata/gitdir-marker-payload'
import { getErrorCode } from '../../git/worktrees/worktree-operation-options'
import {
  readWslCheckoutMarkerState,
  type CheckoutMarkerState,
  type LocalWorktreeFilesystemOptions
} from './local-worktree-filesystem'

export type { CheckoutMarkerState }

function isAbsentMarkerError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Distinguish a missing `.git` from a directory/symlink/foreign `.git` so non-file markers never read as stripped. */
export async function readCheckoutMarkerState(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<CheckoutMarkerState> {
  const wslState = await readWslCheckoutMarkerState(worktreePath, options)
  if (wslState) {
    return wslState
  }
  const gitFile = join(worktreePath, '.git')
  let entry
  try {
    entry = await lstat(gitFile, { bigint: true })
  } catch (error) {
    if (isAbsentMarkerError(error)) {
      return { kind: 'absent' }
    }
    throw error
  }
  if (!entry.isFile()) {
    return { kind: 'other' }
  }
  let contents: string
  try {
    contents = await readFile(gitFile, 'utf8')
  } catch (error) {
    if (isAbsentMarkerError(error)) {
      return { kind: 'absent' }
    }
    throw error
  }
  const gitdir = parseGitdirMarkerPayload(contents)
  return gitdir ? { kind: 'file', identity: `${gitdir}#${entry.ino}` } : { kind: 'other' }
}

/** The admin entry a checkout's `.git` file names plus that file's inode (not the device, which can change across boots): Git reuses admin names, so the name alone cannot tell two checkouts at one path apart. */
export async function readCheckoutMarkerIdentity(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<string | undefined> {
  try {
    const state = await readCheckoutMarkerState(worktreePath, options)
    return state.kind === 'file' ? state.identity : undefined
  } catch {
    return undefined
  }
}
