// Render the same logical state as desktop UNC paths or destination Linux paths; out-of-scope rows stay behind.
import type {
  WslMoveProjectionInput,
  WslMoveProjectionScope
} from '../../moving-wsl-projects/wsl-move-state-projection'
import { foldersAndAutomationsWslMoverProfile } from './wsl-mover-folders-profile'
import { heavyWslMoverProfile } from './wsl-mover-heavy-profile'
import {
  repo,
  worktreeMeta,
  WSL_MOVER_DISTRO,
  wslMoverPaths,
  type WslMoverProfileSide
} from './wsl-mover-profile-rows'

export { WSL_MOVER_DISTRO }

export type WslMoverProfileName = 'heavy-wsl' | 'mixed-windows-wsl' | 'folders-and-automations'
export const WSL_MOVER_PROFILE_NAMES: readonly WslMoverProfileName[] = [
  'heavy-wsl',
  'mixed-windows-wsl',
  'folders-and-automations'
]

export function wslMoverProfileScope(
  name: WslMoverProfileName,
  side: WslMoverProfileSide
): WslMoveProjectionScope {
  const repoIds = name === 'folders-and-automations' ? ['repo-auto'] : ['repo-a', 'repo-b']
  return {
    distro: WSL_MOVER_DISTRO,
    repoIds: new Set(name === 'mixed-windows-wsl' ? ['repo-a'] : repoIds),
    folderWorkspaceIds: new Set(name === 'folders-and-automations' ? ['folder-1'] : []),
    ownerHostId: 'local',
    hostAliases: side === 'source' ? ['local'] : ['local', `runtime:wsl:${WSL_MOVER_DISTRO}`]
  }
}

export function wslMoverProfile(
  name: WslMoverProfileName,
  side: WslMoverProfileSide
): WslMoveProjectionInput {
  const paths = wslMoverPaths(side)
  switch (name) {
    case 'heavy-wsl':
      return heavyWslMoverProfile(paths)
    case 'mixed-windows-wsl':
      return withOutOfScopeRows(heavyWslMoverProfile(paths), side, ['repo-b'])
    case 'folders-and-automations':
      return foldersAndAutomationsWslMoverProfile(paths)
  }
}

function withOutOfScopeRows(
  profile: WslMoveProjectionInput,
  side: WslMoverProfileSide,
  alsoUnscopedRepoIds: readonly string[]
): WslMoveProjectionInput {
  if (side === 'destination') {
    const keep = (repoId: string): boolean => !alsoUnscopedRepoIds.includes(repoId)
    return {
      ...profile,
      state: {
        ...profile.state,
        repos: profile.state.repos.filter((row) => keep(row.id)),
        worktreeMeta: Object.fromEntries(
          Object.entries(profile.state.worktreeMeta).filter(([key]) =>
            keep(key.slice(0, key.indexOf('::')))
          )
        )
      }
    }
  }
  const windowsRepo = repo('repo-win', 'C:\\src\\win')
  const debianRepo = repo('repo-deb', '\\\\wsl.localhost\\Debian\\home\\dev\\other')
  return {
    ...profile,
    state: {
      ...profile.state,
      repos: [...profile.state.repos, windowsRepo, debianRepo],
      worktreeMeta: {
        ...profile.state.worktreeMeta,
        [`repo-win::${windowsRepo.path}`]: worktreeMeta('win'),
        [`repo-deb::${debianRepo.path}`]: worktreeMeta('deb')
      }
    }
  }
}
