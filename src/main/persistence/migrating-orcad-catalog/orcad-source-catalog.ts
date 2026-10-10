import type { OrcadMigrationCatalogPayload } from '../../../shared/orcad-migration-manifest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { SshTarget } from '../../../shared/ssh-types'
import type { Store } from '../../persistence'
import { orcadSourceFolderWorkspaceIds, repoBelongsToOrcadSource } from './orcad-source-ownership'

type OrcadSourceCatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>

export function collectOrcadMigrationSourceCatalog(
  store: OrcadSourceCatalogStore,
  target: Pick<SshTarget, 'id'>
): OrcadMigrationCatalogPayload {
  const allRepos = store.getRepos()
  const allGroups = store.getProjectGroups()
  const allFolders = store.getFolderWorkspaces()
  const repositories = allRepos
    .filter((repo) => repoBelongsToOrcadSource(repo, target.id))
    .map((repo) => structuredClone(repo))
  const ownedFolderIds = orcadSourceFolderWorkspaceIds(
    { repos: allRepos, projectGroups: allGroups, folderWorkspaces: allFolders },
    target.id
  )
  const folderWorkspaces = allFolders
    .filter((workspace) => ownedFolderIds.has(workspace.id))
    .map((workspace) => structuredClone(workspace))
  const projectGroups = collectProjectGroups(
    allGroups,
    new Set([
      ...repositories.flatMap((repo) => (repo.projectGroupId ? [repo.projectGroupId] : [])),
      ...folderWorkspaces.map((workspace) => workspace.projectGroupId),
      ...allGroups.filter((group) => group.connectionId === target.id).map((group) => group.id)
    ])
  )
  return { repositories, projectGroups, folderWorkspaces }
}

function collectProjectGroups(
  groups: ProjectGroup[],
  initialIds: ReadonlySet<string>
): ProjectGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const includedIds = new Set(initialIds)
  const pending = [...initialIds]
  while (pending.length > 0) {
    const nextId = pending.pop()
    if (!nextId) {
      continue
    }
    const group = byId.get(nextId)
    if (!group?.parentGroupId || includedIds.has(group.parentGroupId)) {
      continue
    }
    includedIds.add(group.parentGroupId)
    pending.push(group.parentGroupId)
  }
  return groups.filter((group) => includedIds.has(group.id)).map((group) => structuredClone(group))
}
