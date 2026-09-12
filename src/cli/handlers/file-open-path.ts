import { posix } from 'node:path'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'

/**
 * Why: a WSL workspace stores its worktree root as a Windows UNC path while the
 * user types the Linux path they see inside the distro, so the two never match
 * (#11393). Only the distro the caller is sitting in can name that Linux path, and
 * only a UNC root wants the rewrite — a POSIX root already matches, so rewriting
 * it would strand every absolute path.
 *
 * Backslash is a legal Linux filename character but a separator once the path
 * reads as UNC, so `a\b.ts` would relativize to a different file, `a/b.ts`.
 * Such a path has no Windows spelling; leave it to fail the match instead.
 */
function toWorktreeRootPathFlavor(rootPath: string, cwd: string, path: string): string {
  // Why: WSL_DISTRO_NAME reaches this process only if interop forwards it, but the
  // WSL launcher always sets ORCA_CLI_CWD, and its UNC form names the distro itself.
  const distro = process.env.WSL_DISTRO_NAME || parseWslUncPath(cwd)?.distro
  if (
    !distro ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    !isWslUncPath(rootPath)
  ) {
    return path
  }
  return toWindowsWslPath(path, distro)
}

function pathHasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..')
}

function fileOpenPathsAreComparable(rootPath: string, candidatePath: string): boolean {
  const rootWindows = isWindowsAbsolutePathLike(rootPath) || isWslUncPath(rootPath)
  const candidateWindows = isWindowsAbsolutePathLike(candidatePath) || isWslUncPath(candidatePath)
  return rootWindows === candidateWindows
}

function fileOpenPathFlavor(rootPath: string, path: string): 'posix' | 'windows' {
  if (isWindowsAbsolutePathLike(path) || isWslUncPath(path)) {
    return 'windows'
  }
  // POSIX-absolute user paths keep POSIX separators even when the client cwd is Windows.
  if (path.startsWith('/') && !path.startsWith('//')) {
    return 'posix'
  }
  if (isWindowsAbsolutePathLike(rootPath) || isWslUncPath(rootPath)) {
    return 'windows'
  }
  return 'posix'
}

function resolveFileOpenCandidate(rootPath: string, path: string): string {
  const flavor = fileOpenPathFlavor(rootPath, path)
  // POSIX normalization preserves literal backslashes while resolving dot segments.
  if (flavor === 'posix') {
    return posix.resolve(rootPath, path)
  }
  // Spec: relatives (including dotted) are vs the selected worktree, not client cwd.
  return resolveRuntimePath(rootPath, path)
}

export async function resolveFilePath(
  ctx: HandlerContext,
  worktree: string,
  path: string
): Promise<string> {
  // Why: plain relative paths stay on the single-RPC path. Absolute paths and
  // parent-segment relatives need the worktree root so we can relativize or
  // reject outside-worktree targets with an actionable message (#13949).
  if (!isRuntimePathAbsolute(path) && !pathHasParentSegment(path)) {
    return path
  }
  const result = await ctx.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree
  })
  const worktreePath = result.result.worktree.path
  const flavored = toWorktreeRootPathFlavor(worktreePath, ctx.cwd, path)
  const candidate = resolveFileOpenCandidate(worktreePath, flavored)
  const relativePath = relativePathInsideRoot(worktreePath, candidate)
  if (relativePath === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      'The selected worktree root is a directory, not a file-open target.'
    )
  }
  if (relativePath !== null) {
    return relativePath
  }
  // Same-flavor outside paths get a CLI error. Compare the user path, not a
  // cwd-joined candidate: cross-flavor WSL/SSH misses still reach the runtime.
  if (pathHasParentSegment(path) || fileOpenPathsAreComparable(worktreePath, path)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Path is outside the selected worktree (${worktreePath}). ` +
        'This command only supports files inside a worktree; pass a path under that root or choose a different --worktree.'
    )
  }
  return path
}
