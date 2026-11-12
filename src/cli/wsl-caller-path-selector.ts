import type { FolderWorkspace } from '../shared/folder-workspaces/folder-workspace-types'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import {
  isWslUncPathForCallerLinuxPath,
  isWslUncPathForLinuxMountedPath
} from '../shared/cross-platform-path'
import { parseWslUncPath } from '../shared/wsl-paths'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'

async function listFolderPaths(client: RuntimeClient): Promise<string[]> {
  try {
    const { result } = await client.call<{ folderWorkspaces: FolderWorkspace[] }>(
      'folderWorkspace.list'
    )
    return result.folderWorkspaces.map((folder) => folder.folderPath)
  } catch (error) {
    // An older host has no folder catalog; its worktrees still translate.
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      return []
    }
    throw error
  }
}

/** Resolve Linux selectors to stored UNC paths here, where the caller's distro is known. Worktrees
 * and folder workspaces translate alike; two different stored spellings refuse rather than guess. */
export async function resolveCallerDistroPathSelector(
  selector: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  // A UNC cwd proves Windows/WSL routing; WSL_DISTRO_NAME is also set for Linux-native runtimes.
  const callerDistro = parseWslUncPath(cwd)?.distro
  const linuxPath = selector.startsWith('path:') ? selector.slice(5) : ''
  const isLinuxMountedPath = /^\/mnt\/[A-Za-z](?:\/|$)/.test(linuxPath)
  if (
    (!callerDistro && !isLinuxMountedPath) ||
    client.isRemote ||
    !linuxPath.startsWith('/') ||
    linuxPath.startsWith('//') ||
    // Backslash is a legal Linux filename character but a separator once a path reads as UNC.
    linuxPath.includes('\\')
  ) {
    return selector
  }
  const [worktrees, folderPaths] = await Promise.all([
    client.call<RuntimeWorktreeListResult>('worktree.list', { limit: 10_000 }),
    listFolderPaths(client)
  ])
  const matches = [
    ...new Set(
      [...worktrees.result.worktrees.map((worktree) => worktree.path), ...folderPaths].filter(
        (path) =>
          isLinuxMountedPath
            ? isWslUncPathForLinuxMountedPath(path, linuxPath)
            : isWslUncPathForCallerLinuxPath(path, linuxPath, callerDistro!)
      )
    )
  ]
  if (matches.length > 1) {
    throw new RuntimeClientError(
      'selector_ambiguous',
      `More than one stored path matches ${selector}. Pass one of: ${matches.map((path) => `path:${path}`).join(', ')}.`
    )
  }
  // Preserve unmatched input verbatim; synthesizing a UNC path could guess the wrong distro.
  return matches.length === 1 ? `path:${matches[0]}` : selector
}
