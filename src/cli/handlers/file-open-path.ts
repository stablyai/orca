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

// Only UNC roots need Linux-path translation; backslash filenames have no equivalent Windows spelling.
function toWorktreeRootPathFlavor(rootPath: string, cwd: string, path: string): string {
  // Interop may omit WSL_DISTRO_NAME; the launcher's UNC cwd also identifies the caller's distro.
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
  // Relatives, including dotted ones, resolve against the worktree, not client cwd.
  return resolveRuntimePath(rootPath, path)
}

export async function resolveFilePath(
  ctx: HandlerContext,
  worktree: string,
  path: string
): Promise<string> {
  // Plain relatives skip worktree.show; others need the root to relativize or reject.
  if (!isRuntimePathAbsolute(path) && !pathHasParentSegment(path)) {
    return path
  }
  const result = await ctx.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree
  })
  const worktreePath = result.result.worktree.path
  // Remote roots are stored verbatim; normalize dot segments like the candidate.
  const root = resolveFileOpenCandidate(worktreePath, worktreePath)
  const flavored = toWorktreeRootPathFlavor(worktreePath, ctx.cwd, path)
  const candidate = resolveFileOpenCandidate(root, flavored)
  const relativePath = relativePathInsideRoot(root, candidate)
  if (relativePath === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      'The selected worktree root is a directory, not a file-open target.'
    )
  }
  if (relativePath !== null) {
    return relativePath
  }
  // Compare the raw user path: only same-flavor misses fail here; cross-flavor ones reach the runtime.
  if (pathHasParentSegment(path) || fileOpenPathsAreComparable(worktreePath, path)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Path is outside the selected worktree (${worktreePath}). ` +
        'This command only supports files inside a worktree; pass a path under that root or choose a different --worktree.'
    )
  }
  return path
}
