// Managed-root derivation and containment for audited worktrees. Every check
// here runs BEFORE any Git command, so an unsafe layout is refused with a closed
// reason code rather than half-provisioned.
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'

export const AUDITED_ROOT_SEGMENT = '.orca-audited'

// Why: segments are main-process-generated (randomUUID / `audited_<hex>`), but
// validated anyway — a single reserved name or separator reaching path.join
// would silently relocate the worktree outside the managed tree.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function isSafePathSegment(segment: string): boolean {
  if (!SAFE_SEGMENT.test(segment)) {
    return false
  }
  if (segment === '.' || segment === '..') {
    return false
  }
  return !WINDOWS_RESERVED.test(segment)
}

// Case-insensitive on win32 (NTFS default), case-sensitive elsewhere.
export function pathsEqualForHost(
  a: string,
  b: string,
  platform: string = process.platform
): boolean {
  const normalizedA = stripTrailingSeparator(resolve(a))
  const normalizedB = stripTrailingSeparator(resolve(b))
  return platform === 'win32'
    ? normalizedA.toLowerCase() === normalizedB.toLowerCase()
    : normalizedA === normalizedB
}

function stripTrailingSeparator(value: string): string {
  if (value.length > 1 && value.endsWith(sep)) {
    return value.slice(0, -1)
  }
  return value
}

/**
 * True when `candidate` is the same as, or nested inside, `container`.
 * Operates on already-canonicalized paths; rejects `..`-escaping and absolute
 * relatives the same way ensurePathWithinWorkspace does for ordinary worktrees.
 */
export function isPathInside(
  candidate: string,
  container: string,
  platform: string = process.platform
): boolean {
  if (pathsEqualForHost(candidate, container, platform)) {
    return true
  }
  const rel = relative(resolve(container), resolve(candidate))
  if (rel === '' || isAbsolute(rel)) {
    return false
  }
  const normalized = platform === 'win32' ? rel.toLowerCase() : rel
  return normalized !== '..' && !normalized.startsWith(`..${sep}`) && !normalized.startsWith('../')
}

/**
 * Canonicalize a path whose leaf may not exist yet: walk up to the nearest
 * existing ancestor, realpath THAT (resolving symlinks, junctions and 8.3 short
 * names on the portion that exists), then re-append the non-existent tail.
 */
export function canonicalizeAllowingMissing(targetPath: string): string {
  const absolute = resolve(targetPath)
  const tail: string[] = []
  let current = absolute

  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail.toReversed())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return absolute
      }
      tail.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

export type ManagedRootLayout = {
  managedRoot: string
  worktreePath: string
}

export type ManagedRootResult =
  | { ok: true; layout: ManagedRootLayout }
  | { ok: false; reasonCode: WorktreeReasonCode }

export type ManagedRootInput = {
  workspaceRoot: string
  sourceRepoPath: string
  repoId: string
  taskId: string
}

/**
 * Derives and validates the managed root without creating it. Pure apart from
 * canonicalization probes — `prepareManagedRoot` performs the single mkdir and
 * re-validates afterwards.
 */
export function deriveManagedRootLayout(input: ManagedRootInput): ManagedRootResult {
  if (!isSafePathSegment(input.repoId) || !isSafePathSegment(input.taskId)) {
    return { ok: false, reasonCode: 'managed_root_unavailable' }
  }
  if (!input.workspaceRoot.trim() || !input.sourceRepoPath.trim()) {
    return { ok: false, reasonCode: 'managed_root_unavailable' }
  }

  const workspaceRoot = canonicalizeAllowingMissing(input.workspaceRoot)
  const managedRoot = join(workspaceRoot, AUDITED_ROOT_SEGMENT, input.repoId)
  const worktreePath = join(managedRoot, input.taskId)

  return validateLayout({
    workspaceRoot,
    sourceRepoPath: canonicalizeAllowingMissing(input.sourceRepoPath),
    managedRoot: canonicalizeAllowingMissing(managedRoot),
    worktreePath: canonicalizeAllowingMissing(worktreePath)
  })
}

function validateLayout(paths: {
  workspaceRoot: string
  sourceRepoPath: string
  managedRoot: string
  worktreePath: string
}): ManagedRootResult {
  if (!isPathInside(paths.managedRoot, paths.workspaceRoot)) {
    return { ok: false, reasonCode: 'managed_root_escapes_workspace' }
  }
  // Both directions matter: a workspaceDir configured inside the repo would put
  // audited worktrees under version control; a repo inside the managed root
  // would make the guard's containment checks meaningless.
  if (isPathInside(paths.managedRoot, paths.sourceRepoPath)) {
    return { ok: false, reasonCode: 'managed_root_inside_source_repo' }
  }
  if (isPathInside(paths.sourceRepoPath, paths.managedRoot)) {
    return { ok: false, reasonCode: 'source_repo_inside_managed_root' }
  }
  if (!isPathInside(paths.worktreePath, paths.managedRoot)) {
    return { ok: false, reasonCode: 'worktree_path_outside_managed_root' }
  }
  return {
    ok: true,
    layout: { managedRoot: paths.managedRoot, worktreePath: paths.worktreePath }
  }
}

/**
 * Creates the managed root and re-validates containment afterwards. The second
 * canonicalization is what catches a symlink/junction swapped in between
 * derivation and mkdir.
 */
export function prepareManagedRoot(input: ManagedRootInput): ManagedRootResult {
  const derived = deriveManagedRootLayout(input)
  if (!derived.ok) {
    return derived
  }

  try {
    mkdirSync(derived.layout.managedRoot, { recursive: true })
  } catch {
    return { ok: false, reasonCode: 'managed_root_unavailable' }
  }

  return validateLayout({
    workspaceRoot: canonicalizeAllowingMissing(input.workspaceRoot),
    sourceRepoPath: canonicalizeAllowingMissing(input.sourceRepoPath),
    managedRoot: canonicalizeAllowingMissing(derived.layout.managedRoot),
    worktreePath: canonicalizeAllowingMissing(derived.layout.worktreePath)
  })
}
