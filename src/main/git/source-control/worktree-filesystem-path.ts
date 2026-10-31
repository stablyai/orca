import { resolveGitMetadataPath } from '../../../shared/git-metadata-path'
import type { GitRuntimeOptions } from '../git-runtime-options'

const GUEST_ROOTED_PATH = /^\/(?!\/)/

/** Reject UNC and edge-whitespace paths: translating or trimming them can identify another directory. */
function isRespellableGuestPath(worktreePath: string): boolean {
  return GUEST_ROOTED_PATH.test(worktreePath) && worktreePath === worktreePath.trim()
}

/** Convert WSL guest paths only for Node filesystem reads; Git keeps its execution-host spelling. */
export function resolveWorktreeFilesystemPath(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): string {
  if (process.platform !== 'win32' || !isRespellableGuestPath(worktreePath)) {
    return worktreePath
  }
  return resolveGitMetadataPath('', worktreePath, options) ?? worktreePath
}
