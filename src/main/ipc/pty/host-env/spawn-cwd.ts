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
  getFolderWorkspacePathStatus,
  resolveFolderWorkspaceStatusPath
} from '../../../project-groups/folder-workspace-path-status'
import {
  isWslMoveCwdFenced,
  isWslMoveWorkspaceBlocked,
  wslMoveHostDistro,
  wslMoveProjectRefForWorkspace,
  WslMoveProjectFencedError
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { listLiveDaemonPtyIds } from '../../../daemon/daemon-provider-state'
import { wslDistroHoldMessage } from '../../../../shared/wsl-distro-stopped-hold'
import {
  blockedWslDistroForPath,
  runAsWslUserAct,
  wslDistroForPath
} from '../../../wsl/wsl-unc-access-gate'

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
  cwd?: string,
  passiveWslRestore?: boolean
): Promise<void> | void {
  const fencedByCwd = !!cwd && isWslMoveCwdFenced(cwd)
  if (fencedByCwd || isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId, worktreeId).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId, passiveWslRestore)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId, passiveWslRestore)
}

/** Only a spawn on this machine starts in a folder a WSL move can be taking. */
export function localPtySpawnCwd(args: {
  connectionId?: string | null
  cwd?: string
}): string | undefined {
  return args.connectionId ? undefined : args.cwd
}

async function assertReattachesLiveSession(
  sessionId: string | undefined,
  worktreeId: string | undefined
): Promise<void> {
  // An unanswered census is never proof the session lives, so it refuses.
  const live = sessionId ? await listLiveDaemonPtyIds() : null
  if (!sessionId || !live?.includes(sessionId)) {
    // A committed move's project names its host: "try again when the move finishes" never comes true.
    throw new WslMoveProjectFencedError(
      worktreeId ? wslMoveHostDistro(wslMoveProjectRefForWorkspace(worktreeId)) : null
    )
  }
}

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined,
  passiveWslRestore = false
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  const request = {
    scope: 'folder-workspace',
    folderWorkspaceId: workspaceScope.folderWorkspaceId
  } as const
  return checkFolderWorkspacePtyPath(store, request, passiveWslRestore)
}

/**
 * A spawn the user asked for may start the folder's stopped WSL distro (as before): its check runs
 * as their act. A passive restore holds with Start instead, the same as a bridge pane's (E9).
 */
async function checkFolderWorkspacePtyPath(
  store: Store,
  request: { scope: 'folder-workspace'; folderWorkspaceId: string },
  passiveWslRestore: boolean
): Promise<void> {
  const { folderPath } = resolveFolderWorkspaceStatusPath({ store, request })
  if (passiveWslRestore) {
    const blocked = await blockedWslDistroForPath(folderPath)
    if (blocked) {
      throw new Error(wslDistroHoldMessage(blocked.distro, blocked.state))
    }
    assertFolderWorkspacePathUsable(await getFolderWorkspacePathStatus(store, request))
    return
  }
  assertFolderWorkspacePathUsable(
    await runAsWslUserAct(wslDistroForPath(folderPath), () =>
      getFolderWorkspacePathStatus(store, request)
    )
  )
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
