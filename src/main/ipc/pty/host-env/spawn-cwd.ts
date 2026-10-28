import { stat } from 'node:fs/promises'
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
import {
  isWslMoveCwdFenced,
  isWslMoveWorkspaceBlocked,
  WslMoveProjectFencedError
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { listLiveDaemonPtyIds } from '../../../daemon/daemon-provider-state'

/**
 * A new PTY needs a workspace no WSL move is taking, and a folder that still exists. Reattaching to
 * a session the daemon still runs is not a new PTY: a reload mid-move must not orphan a live pane.
 * The requested folder counts too: a terminal from anywhere that starts inside a moving project
 * would outlive the move there (a floating terminal, a Windows project's WSL tab, `--cwd`).
 */
export function assertWorkspaceAcceptsNewPty(
  store: Store | undefined,
  worktreeId: string | undefined,
  sessionId?: string,
  cwd?: string
): Promise<void> | void {
  const fencedByCwd = !!cwd && isWslMoveCwdFenced(cwd)
  if (fencedByCwd || isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId)
}

/** Only a spawn on this machine starts in a folder a WSL move can be taking. */
export function localPtySpawnCwd(args: {
  connectionId?: string | null
  cwd?: string
}): string | undefined {
  return args.connectionId ? undefined : args.cwd
}

async function assertReattachesLiveSession(sessionId: string | undefined): Promise<void> {
  // An unanswered census is never proof the session lives, so it refuses.
  const live = sessionId ? await listLiveDaemonPtyIds() : null
  if (!sessionId || !live?.includes(sessionId)) {
    throw new WslMoveProjectFencedError()
  }
}

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  return getFolderWorkspacePathStatus(store, {
    scope: 'folder-workspace',
    folderWorkspaceId: workspaceScope.folderWorkspaceId
  }).then(assertFolderWorkspacePathUsable)
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

export async function localStartupCwdDirectoryExists(path: string): Promise<boolean> {
  // Win32 9P stat can falsely report WSL-share absence; defer to WSL-aware provider validation.
  if (isWslUncPath(path)) {
    return true
  }
  // A dead network mount must not block main's event loop.
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
