import { getAppEnvironment } from '../../../shared/app-environment'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'

import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration/orcad-migration-source-cutover'
import type { Repo } from '../../../shared/repo-types'
import type { SshTarget } from '../../../shared/ssh-types'
import type { Store } from '../loading-store/store'
import {
  orcadSourceFolderWorkspaceIds,
  projectGroupBelongsToOrcadSource,
  repoBelongsToOrcadSource
} from './orcad-source-ownership'

import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'
import {
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos
} from '../moving-wsl-projects/wsl-move-scope-guard'

export const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

export type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>

/** Hide only retained committed source without later additions; in-flight or unjournaled fences leave source rows visible. */
function isHiddenRetainedSourceTarget(
  userDataPath: string,
  target: Pick<SshTarget, 'id' | 'orcadFence'>
): boolean {
  if (!target.orcadFence || target.orcadFence.sourceChangedAt) {
    return false
  }
  let head: OrcadMigrationSourceCutover | null
  try {
    head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
  } catch {
    return true // An unreadable journal keeps the host fenced, and so hidden.
  }
  return (
    head !== null &&
    (head.phase === 'destination-committed' ||
      head.phase === 'source-retired' ||
      head.destinationEnvironmentId !== target.orcadFence.environmentId)
  )
}

/** Delay journal reads until a host is fenced. */
export function hiddenRetainedSourceTargetIds(
  getUserDataPath: () => string,
  targets: readonly SshTarget[]
): string[] {
  return targets
    .filter(
      (target) => target.orcadFence && isHiddenRetainedSourceTarget(getUserDataPath(), target)
    )
    .map((target) => target.id)
}

/** Freeze fenced ssh: partitions: renderer saves could mutate in-flight source or strip retained rows after commit. */
export function isFrozenOrcadSourceSessionPartition(
  store: Pick<Store, 'getSshTarget'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  const fence = parsed?.kind === 'ssh' ? store.getSshTarget(parsed.targetId)?.orcadFence : undefined
  return fence !== undefined && !fence.sourceChangedAt
}

export function visibleRepos(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): Repo[] {
  return reposShownWith(
    store.getRepos(),
    hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  )
}

function reposShownWith(allRepos: Repo[], hiddenTargets: readonly string[]): Repo[] {
  const repos = withoutWslMovedRepos(allRepos)
  if (hiddenTargets.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hiddenTargets.some((targetId) => repoBelongsToOrcadSource(repo, targetId))
  )
}

/** Keep local groups that merely contain host-owned projects. */
export function visibleProjectGroups(
  store: Pick<Store, 'getProjectGroups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectGroup[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const groups = store.getProjectGroups()
  if (hidden.length === 0) {
    return groups
  }
  return groups.filter(
    (group) => !hidden.some((targetId) => projectGroupBelongsToOrcadSource(group, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const folderWorkspaces = withoutWslMovedFolderWorkspaces(store.getFolderWorkspaces())
  if (hidden.length === 0) {
    return folderWorkspaces
  }
  const state = {
    repos: store.getRepos(),
    projectGroups: store.getProjectGroups(),
    folderWorkspaces
  }
  const hiddenIds = new Set(
    hidden.flatMap((targetId) => [...orcadSourceFolderWorkspaceIds(state, targetId)])
  )
  return folderWorkspaces.filter((workspace) => !hiddenIds.has(workspace.id))
}

/** Hide setups with their source repo rows so managed server listings do not duplicate same-id setups (#30859). */
export function visibleProjectHostSetups(
  store: CatalogStore & Pick<Store, 'getProjectHostSetups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectHostSetup[] {
  const setups = store.getProjectHostSetups()
  if (setups.length === 0) {
    return setups
  }
  const hiddenTargets = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const allRepos = store.getRepos()
  const shownRepos = reposShownWith(allRepos, hiddenTargets)
  if (hiddenTargets.length === 0 && shownRepos.length === allRepos.length) {
    return setups
  }
  const rowKey = (hostId: string, repoId: string): string => `${hostId}\0${repoId}`
  const shownKeys = new Set(shownRepos.map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id)))
  const hiddenKeys = new Set(
    allRepos
      .map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id))
      .filter((key) => !shownKeys.has(key))
  )
  return setups.filter((setup) => {
    if (setup.repoId && hiddenKeys.has(rowKey(setup.hostId, setup.repoId))) {
      return false
    }
    // Repo-less placeholders have no row to follow, so the hidden host decides for them.
    const host = parseExecutionHostId(setup.hostId)
    return !(host?.kind === 'ssh' && hiddenTargets.includes(host.targetId))
  })
}
