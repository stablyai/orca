import { resolveQualifiedFolderWorkspaceResult } from '../../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  getConnectionExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
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
  getResolvedFolderWorkspacePathStatus
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
  passiveWslRestore?: boolean,
  connectionId?: string | null
): Promise<void> | void {
  const fencedByCwd = !!cwd && isWslMoveCwdFenced(cwd)
  if (fencedByCwd || isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId, worktreeId).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId, passiveWslRestore, connectionId)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId, passiveWslRestore, connectionId)
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
  passiveWslRestore = false,
  connectionId?: string | null
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  const selected = resolveSpawnFolder(store, workspaceScope.folderWorkspaceId, connectionId)
  if (selected.kind === 'missing') {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  if (selected.kind !== 'selected') {
    return getFolderWorkspacePathStatus(store, {
      scope: 'folder-workspace',
      folderWorkspaceId: workspaceScope.folderWorkspaceId
    }).then(assertFolderWorkspacePathUsable)
  }
  return checkFolderWorkspacePtyPath(
    selected.value.workspace,
    selected.value.hostId,
    passiveWslRestore
  )
}

/** A passive check holds before touching a stopped distro; only the user's spawn may start it. */
async function checkFolderWorkspacePtyPath(
  workspace: Pick<FolderWorkspace, 'folderPath'>,
  hostId: ExecutionHostId,
  passiveWslRestore: boolean
): Promise<void> {
  const checkPath = () => getResolvedFolderWorkspacePathStatus(workspace, hostId)
  if (hostId !== 'local') {
    assertFolderWorkspacePathUsable(await checkPath())
    return
  }
  if (passiveWslRestore) {
    const blocked = await blockedWslDistroForPath(workspace.folderPath)
    if (blocked) {
      throw new Error(wslDistroHoldMessage(blocked.distro, blocked.state))
    }
    assertFolderWorkspacePathUsable(await checkPath())
    return
  }
  assertFolderWorkspacePathUsable(
    await runAsWslUserAct(wslDistroForPath(workspace.folderPath), checkPath)
  )
}

export function resolvePtySpawnStartupCwd(
  store: Store | undefined,
  worktreeId: string | undefined,
  cwd: string | undefined,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback,
  connectionId?: string | null
): string | undefined {
  return resolveTerminalStartupCwdForWorkspace({
    workspaceId: worktreeId,
    requestedCwd: cwd,
    missingDirFallback,
    resolveFolderWorkspacePath: (folderWorkspaceId) =>
      store
        ? (() => {
            const result = resolveQualifiedFolderWorkspaceResult(
              {
                folderWorkspaces: store.getFolderWorkspaces(),
                projectGroups: store.getProjectGroups(),
                repos: store.getRepos()
              },
              folderWorkspaceId,
              getConnectionExecutionHostId(connectionId)
            )
            return result.kind === 'selected' ? result.value.workspace.folderPath : undefined
          })()
        : undefined
  })
}

function resolveSpawnFolder(store: Store, id: string, connectionId?: string | null) {
  return resolveQualifiedFolderWorkspaceResult(
    {
      folderWorkspaces: store.getFolderWorkspaces(),
      projectGroups: store.getProjectGroups(),
      repos: store.getRepos()
    },
    id,
    getConnectionExecutionHostId(connectionId)
  )
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
