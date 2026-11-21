import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGitdirMarkerPayload } from '../../../shared/git/metadata/gitdir-marker-payload'
import { differentCheckoutAtPathError } from '../../../shared/worktree/removal/removal'
import { getErrorCode } from '../../git/worktrees/worktree-operation-options'
import {
  getLocalWorktreePathAccess,
  readWslCheckoutMarkerState,
  type CheckoutMarkerState,
  type LocalWorktreeFilesystemOptions
} from './local-worktree-filesystem'
import { getPathOps } from './worktree-removal-home-guard'

export type { CheckoutMarkerState }

export type AcceptedCheckoutGuard = {
  gitdir: string | undefined
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean }
  verify: () => Promise<void>
}

export type ProvenOrphanCheckoutGuard = {
  markerLast: true
  expectedMarker?: string
  forbidAnyMarker?: boolean
}

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

export async function captureAcceptedCheckoutGuard(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<AcceptedCheckoutGuard> {
  const initial = await readCheckoutMarkerState(worktreePath, options)
  if (initial.kind === 'other') {
    throw differentCheckoutAtPathError(worktreePath)
  }
  const gitdir = initial.kind === 'file' ? initial.identity : undefined
  const forbidAnyMarker = initial.kind === 'absent'
  return {
    gitdir,
    markerOptions: {
      ...(gitdir !== undefined ? { expectedMarker: gitdir } : {}),
      ...(forbidAnyMarker ? { forbidAnyMarker: true } : {})
    },
    verify: async () => {
      const current = await readCheckoutMarkerState(worktreePath, options)
      if (current.kind === 'absent') {
        return
      }
      if (forbidAnyMarker || current.kind !== 'file' || current.identity !== gitdir) {
        throw differentCheckoutAtPathError(worktreePath)
      }
    }
  }
}

/** Bind orphan ownership proof to the exact `.git` marker read before and after proof so teardown races cannot swap in another checkout. */
export async function proveOrphanedCheckoutGuard(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions,
  prove: () => Promise<boolean>
): Promise<ProvenOrphanCheckoutGuard | null> {
  const before = await readCheckoutMarkerState(worktreePath, options)
  if (before.kind === 'other') {
    return null
  }
  if (!(await prove())) {
    return null
  }
  const after = await readCheckoutMarkerState(worktreePath, options)
  if (after.kind === 'absent') {
    return { markerLast: true, forbidAnyMarker: true }
  }
  if (before.kind !== 'file' || after.kind !== 'file' || after.identity !== before.identity) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  return { markerLast: true, expectedMarker: before.identity }
}

/** A checkout folder still on disk whose `.git` link is gone. */
export async function isCheckoutMissingGitLink(
  checkoutPath: string,
  options: LocalWorktreeFilesystemOptions
): Promise<boolean> {
  const { statPath: stat } = getLocalWorktreePathAccess(options, checkoutPath)
  try {
    await stat(checkoutPath)
  } catch {
    // Git removes a registration whose folder is gone; other errors are Git's to report.
    return false
  }
  try {
    await stat(getPathOps(checkoutPath).join(checkoutPath, '.git'))
    return false
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
}
