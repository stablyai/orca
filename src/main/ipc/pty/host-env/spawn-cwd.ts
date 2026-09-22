import { statSync } from 'node:fs'
import type { Store } from '../../../persistence'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  resolveTerminalStartupCwdForWorkspace,
  type TerminalStartupCwdMissingDirFallback
} from '../../../../shared/terminal-startup-cwd'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus
} from '../../../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  return getFolderWorkspacePathStatus(
    store,
    { scope: 'folder-workspace', folderWorkspaceId: workspaceScope.folderWorkspaceId },
    { getSshFilesystemProvider }
  ).then(assertFolderWorkspacePathUsable)
}

export function resolvePtySpawnStartupCwd(
  store: Store | undefined,
  worktreeId: string | undefined,
  cwd: string | undefined,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback
): string | undefined {
  return resolveTerminalStartupCwdForWorkspace({
    workspaceId: worktreeId,
    requestedCwd: cwd,
    missingDirFallback,
    resolveFolderWorkspacePath: (folderWorkspaceId) =>
      store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  })
}

export function localStartupCwdDirectoryExists(path: string): boolean {
  // Why: Win32 statSync on \\wsl.localhost 9P shares can falsely report ENOENT; defer to the provider's WSL-aware validation.
  if (isWslUncPath(path)) {
    return true
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
