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
import {
  isWslMoveWorkspaceBlocked,
  WslMoveProjectFencedError
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { listLiveDaemonPtyIds } from '../../../daemon/daemon-provider-state'
import {
  isTerminalAdmissionClosed,
  TerminalAdmissionClosedError
} from '../../../runtime/terminal-admission-fence'

/**
 * A new PTY needs a server not stopping for an update, a workspace no WSL move is taking, and a
 * folder that still exists. Reattaching to a session the daemon still runs is not a new PTY: a
 * reload mid-move or mid-update must not orphan a live pane.
 */
export function assertWorkspaceAcceptsNewPty(
  store: Store | undefined,
  worktreeId: string | undefined,
  sessionId?: string
): Promise<void> | void {
  if (isTerminalAdmissionClosed()) {
    return assertReattachesLiveSession(sessionId, () => new TerminalAdmissionClosedError()).then(
      () => assertWorkspaceNotMoving(store, worktreeId, sessionId)
    )
  }
  return assertWorkspaceNotMoving(store, worktreeId, sessionId)
}

/** The update fence alone, rechecked where the spawn actually starts (see runAdmittedTerminalSpawn). */
export function assertTerminalAdmissionOpen(sessionId: string | undefined): Promise<void> | void {
  if (isTerminalAdmissionClosed()) {
    return assertReattachesLiveSession(sessionId, () => new TerminalAdmissionClosedError())
  }
}

function assertWorkspaceNotMoving(
  store: Store | undefined,
  worktreeId: string | undefined,
  sessionId: string | undefined
): Promise<void> | void {
  if (isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId, () => new WslMoveProjectFencedError()).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId)
}

async function assertReattachesLiveSession(
  sessionId: string | undefined,
  refusal: () => Error
): Promise<void> {
  // An unanswered census is never proof the session lives, so it refuses.
  const live = sessionId ? await listLiveDaemonPtyIds() : null
  if (!sessionId || !live?.includes(sessionId)) {
    throw refusal()
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
