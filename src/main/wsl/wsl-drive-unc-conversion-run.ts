/**
 * Starts converting UNC Windows-drive projects to their drive paths (D1c): check them, put their
 * terminals to sleep through the mover's pause (gate, then Sleep keeping each shell's folder),
 * journal the conversion and restart. The next startup rewrites everything before the window
 * opens (wsl-drive-unc-conversion-startup.ts); the woken panes reattach to their renamed sessions.
 */
import type { PersistedState } from '../../shared/persisted-state-types'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import type {
  WslDriveUncConversionBlocker,
  WslDriveUncConversionRequest,
  WslDriveUncConversionResult
} from '../../shared/wsl-drive-unc-conversion-types'
import type { WslMoveRefusal } from '../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveTerminalScope } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import { wslMoveRepoPaths } from '../persistence/moving-wsl-projects/wsl-move-scope'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import {
  windowsGitAvailable,
  wslAuthoredWorktreePaths,
  type WslDriveProjectDeps
} from './wsl-drive-project-windows-git'
import { collectWslDriveUncScope, wslUncDrivePathToWindows } from './wsl-drive-unc-project-scope'
import { rewriteWslDriveUncState } from './wsl-drive-unc-state-rewrite'

export type WslDriveUncConversionRunDeps = Pick<
  WslDriveProjectDeps,
  'runWindowsGit' | 'readWorktreeLinks'
> & {
  userDataPath: string
  /** The saved profile, flushed first: the dry run must see what the restart will rewrite. */
  readProfileState: () => Promise<PersistedState>
  pause: (scope: WslMoveTerminalScope) => Promise<{ panes: readonly unknown[] } | WslMoveRefusal>
  restart: () => void
  newMigrationId: () => string
  now: () => Date
}

export async function startWslDriveUncConversion(
  deps: WslDriveUncConversionRunDeps,
  request: WslDriveUncConversionRequest
): Promise<WslDriveUncConversionResult> {
  if (listWslDriveUncConversions(deps.userDataPath).length > 0) {
    return refused([{ kind: 'conversion-pending' }])
  }
  const state = await deps.readProfileState()
  const checked = checkScope(state, request)
  if ('blockers' in checked) {
    return refused(checked.blockers)
  }
  const { repoIds, folderWorkspaceIds } = checked
  let worktreeIds: Map<string, string>
  try {
    ;({ worktreeIds } = rewriteWslDriveUncState(state, {
      distro: request.distro,
      repoIds,
      folderWorkspaceIds
    }))
  } catch (error) {
    return refused([{ kind: 'state-conflict', detail: describe(error) }])
  }
  const repos = state.repos.filter((repo) => repoIds.includes(repo.id))
  const gitBlockers = await windowsGitBlockers(deps, repos, request.distro)
  if (gitBlockers.length > 0) {
    return refused(gitBlockers)
  }
  const workspaceKeys = [
    ...new Set([...worktreeIds.keys(), ...repos.map(getRepoMainWorktreeId)]),
    ...folderWorkspaceIds.map((id) => `folder:${id}`)
  ]
  const paused = await deps.pause({
    workspaceIds: workspaceKeys,
    workspaceKeys: new Set(workspaceKeys)
  })
  if ('outcome' in paused) {
    return paused.code === 'wsl_move_terminals_blocked'
      ? { outcome: 'terminals-blocked', blockers: paused.blockers ?? [] }
      : { outcome: 'pause-failed', detail: paused.detail ?? paused.code }
  }
  const migrationId = deps.newMigrationId()
  const at = deps.now().toISOString()
  writeWslDriveUncConversion(deps.userDataPath, {
    version: 1,
    migrationId,
    distro: request.distro,
    repoIds,
    folderWorkspaceIds,
    rootPaths: [
      ...repos.flatMap(wslMoveRepoPaths),
      ...state.folderWorkspaces
        .filter((folder) => folderWorkspaceIds.includes(folder.id))
        .map((folder) => folder.folderPath)
    ],
    phase: 'prepared',
    // The panes slept since the dry run; the startup rewrite adds any id they introduced.
    worktreeIds: [...worktreeIds],
    rewrittenStores: [],
    createdAt: at,
    updatedAt: at
  })
  deps.restart()
  return { outcome: 'restarting', migrationId }
}

function checkScope(
  state: PersistedState,
  request: WslDriveUncConversionRequest
):
  | { repoIds: string[]; folderWorkspaceIds: string[] }
  | { blockers: WslDriveUncConversionBlocker[] } {
  const scope = collectWslDriveUncScope(state, request.distro)
  const blockers: WslDriveUncConversionBlocker[] = []
  const pick = (ids: readonly string[], allowed: readonly string[]): string[] =>
    ids.filter((id) => {
      if (allowed.includes(id)) {
        return true
      }
      const reason = scope.refused.find((entry) => entry.id === id)?.reason ?? 'not-in-scope'
      blockers.push({ kind: 'not-convertible', id, reason })
      return false
    })
  const repoIds = pick(request.repoIds, scope.repoIds)
  const folderWorkspaceIds = pick(request.folderWorkspaceIds ?? [], scope.folderWorkspaceIds)
  if (repoIds.length + folderWorkspaceIds.length === 0 && blockers.length === 0) {
    blockers.push({ kind: 'not-convertible', id: '', reason: 'not-in-scope' })
  }
  return blockers.length > 0 ? { blockers } : { repoIds, folderWorkspaceIds }
}

/** Windows Git runs in the drive path, which is the same folder the distro shows. */
async function windowsGitBlockers(
  deps: Pick<WslDriveProjectDeps, 'runWindowsGit' | 'readWorktreeLinks'>,
  repos: readonly PersistedState['repos'][number][],
  distro: string
): Promise<WslDriveUncConversionBlocker[]> {
  const gitRepos = repos.flatMap((repo) => {
    const path = repo.kind === 'folder' ? null : wslUncDrivePathToWindows(repo.path, distro)
    return path ? [{ repoId: repo.id, path }] : []
  })
  if (gitRepos.length === 0) {
    return []
  }
  if (!(await windowsGitAvailable(deps.runWindowsGit, gitRepos[0].path))) {
    return [{ kind: 'windows-git-missing' }]
  }
  const blockers: WslDriveUncConversionBlocker[] = []
  for (const { repoId, path } of gitRepos) {
    const paths = await wslAuthoredWorktreePaths(deps, path)
    if (paths.length > 0) {
      blockers.push({ kind: 'wsl-authored-worktrees', repoId, paths })
    }
  }
  return blockers
}

function refused(blockers: WslDriveUncConversionBlocker[]): WslDriveUncConversionResult {
  return { outcome: 'refused', blockers }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
