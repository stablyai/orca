import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGitdirMarkerPayload } from '../../../shared/git/metadata/gitdir-marker-payload'
import {
  differentCheckoutAtPathError,
  unconfirmedCheckoutAtPathError
} from '../../../shared/worktree/removal/removal'
import { getErrorCode } from '../../git/worktrees/worktree-operation-options'
import {
  getLocalWorktreePathAccess,
  readWslCheckoutMarkerState,
  readWslCheckoutRootState,
  type CheckoutMarkerState,
  type CheckoutRootState,
  type LocalWorktreeFilesystemOptions
} from './local-worktree-filesystem'
import { getPathOps } from './worktree-removal-home-guard'

export type { CheckoutMarkerState, CheckoutRootState }

export type AcceptedCheckoutGuard = {
  gitdir: string | undefined
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean }
  verify: () => Promise<void>
}

export type ProvenOrphanCheckoutGuard = {
  markerLast: true
  expectedMarker?: string
  forbidAnyMarker?: boolean
  expectedRoot?: string
  requireMarker?: boolean
  alreadyAbsent?: boolean
}

function isAbsentMarkerError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function readCheckoutRootState(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<CheckoutRootState> {
  const wslRoot = await readWslCheckoutRootState(worktreePath, options)
  if (wslRoot) {
    return wslRoot
  }
  try {
    const entry = await lstat(worktreePath, { bigint: true })
    if (
      !entry.isDirectory() ||
      (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())
    ) {
      return { kind: 'other' }
    }
    const identity =
      entry.dev !== undefined && entry.ino !== undefined ? `${entry.dev}:${entry.ino}` : undefined
    return { kind: 'directory', ...(identity ? { identity } : {}) }
  } catch (error) {
    if (isAbsentMarkerError(error)) {
      return { kind: 'absent' }
    }
    throw error
  }
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
    let after
    try {
      contents = await readFile(gitFile, 'utf8')
      after = await lstat(gitFile, { bigint: true })
    } catch (error) {
      if (isAbsentMarkerError(error)) {
        return { kind: 'absent' }
      }
      throw error
    }
    if (!after.isFile()) {
      return { kind: 'other' }
    }
    if (after.dev !== entry.dev || after.ino !== entry.ino) {
      continue
    }
    const gitdir = parseGitdirMarkerPayload(contents)
    return gitdir ? { kind: 'file', identity: `${gitdir}#${entry.ino}` } : { kind: 'other' }
  }
  return { kind: 'other' }
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
    throw unconfirmedCheckoutAtPathError(worktreePath)
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

/** Bind orphan ownership proof to the exact directory and `.git` marker read before and after proof so teardown races cannot swap in another folder or checkout. */
export async function proveOrphanedCheckoutGuard(
  worktreePath: string,
  options: LocalWorktreeFilesystemOptions,
  prove: () => Promise<boolean>,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<ProvenOrphanCheckoutGuard | null> {
  const { expectedMarker, forbidAnyMarker = false } = markerOptions
  const rootBefore = await readCheckoutRootState(worktreePath, options)
  if (rootBefore.kind !== 'directory') {
    return null
  }
  const before = await readCheckoutMarkerState(worktreePath, options)
  if (before.kind !== 'absent' && forbidAnyMarker) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  if (
    expectedMarker !== undefined &&
    before.kind !== 'absent' &&
    (before.kind !== 'file' || before.identity !== expectedMarker)
  ) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  if (before.kind !== 'file') {
    return null
  }
  if (!(await prove())) {
    return null
  }
  const rootAfter = await readCheckoutRootState(worktreePath, options)
  if (rootAfter.kind === 'absent') {
    return {
      markerLast: true,
      forbidAnyMarker: true,
      alreadyAbsent: true,
      ...(rootBefore.identity ? { expectedRoot: rootBefore.identity } : {})
    }
  }
  if (
    rootAfter.kind !== 'directory' ||
    (rootBefore.identity && rootAfter.identity && rootAfter.identity !== rootBefore.identity)
  ) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  const expectedRoot = rootAfter.identity ?? rootBefore.identity
  const after = await readCheckoutMarkerState(worktreePath, options)
  if (after.kind === 'absent') {
    return {
      markerLast: true,
      forbidAnyMarker: true,
      requireMarker: true,
      ...(expectedRoot ? { expectedRoot } : {})
    }
  }
  const requiredIdentity = expectedMarker ?? (before.kind === 'file' ? before.identity : undefined)
  if (
    forbidAnyMarker ||
    requiredIdentity === undefined ||
    after.kind !== 'file' ||
    after.identity !== requiredIdentity
  ) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  return {
    markerLast: true,
    expectedMarker: requiredIdentity,
    requireMarker: true,
    ...(expectedRoot ? { expectedRoot } : {})
  }
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
