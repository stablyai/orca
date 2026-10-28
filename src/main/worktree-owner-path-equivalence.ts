import { type posix, win32 } from 'node:path'
import { isDefinitiveAbsence } from '../shared/definitive-filesystem-absence'
import type { WorktreeProofAccess } from './worktree-orphan-gitdir-proof'

type PathOps = typeof posix

export function areResolvedPathsEqual(
  leftPath: string,
  rightPath: string,
  pathOps: PathOps
): boolean {
  const left = pathOps.normalize(pathOps.resolve(leftPath))
  const right = pathOps.normalize(pathOps.resolve(rightPath))
  return pathOps === win32 ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function readOwnerCanonicalPath(
  path: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<string | null> {
  try {
    const resolved = await access.realPath(path)
    if (typeof resolved !== 'string' || !pathOps.isAbsolute(resolved) || resolved.includes('\0')) {
      throw new Error('Invalid owning-host canonical path')
    }
    return resolved
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

export async function canonicalOwnerPathsEqual(
  left: string,
  right: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<boolean> {
  const [a, b] = await Promise.all([
    readOwnerCanonicalPath(left, pathOps, access),
    readOwnerCanonicalPath(right, pathOps, access)
  ])
  return a !== null && b !== null && areResolvedPathsEqual(a, b, pathOps)
}

export async function isDirectWorktreeAdmin(
  admin: string,
  worktrees: string,
  pathOps: PathOps,
  access: WorktreeProofAccess
): Promise<boolean> {
  const parent = pathOps.dirname(admin)
  if (
    areResolvedPathsEqual(admin, parent, pathOps) ||
    areResolvedPathsEqual(admin, worktrees, pathOps)
  ) {
    return false
  }
  if (areResolvedPathsEqual(parent, worktrees, pathOps)) {
    return true
  }
  const [actual, expected] = await Promise.all([
    readOwnerCanonicalPath(parent, pathOps, access),
    readOwnerCanonicalPath(worktrees, pathOps, access)
  ])
  if (actual !== null || expected !== null) {
    return actual !== null && expected !== null && areResolvedPathsEqual(actual, expected, pathOps)
  }
  const name = pathOps.basename(parent)
  if ((pathOps === win32 ? name.toLowerCase() : name) !== 'worktrees') {
    return false
  }
  // Missing worktrees directories prove namespace only; the admin must still prove absent.
  return canonicalOwnerPathsEqual(
    pathOps.dirname(parent),
    pathOps.dirname(worktrees),
    pathOps,
    access
  )
}
