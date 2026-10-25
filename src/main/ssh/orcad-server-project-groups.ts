/** The project groups a managed server already holds, so a relink keeps its record of them. */
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadServerFolderCatalog } from './orcad-server-folder-workspaces'

/**
 * Incoming groups the server holds under the same id on its own machine: its copy from an earlier
 * move, found even when no server row sits in it. One it keeps for another host isn't the same.
 */
export function projectGroupsHeldByServer(
  incoming: readonly { id: string }[],
  server: Pick<OrcadServerFolderCatalog, 'projectGroups'>
): string[] {
  const local = new Set(server.projectGroups.filter(isRepoOnCatalogHost).map((group) => group.id))
  return incoming.filter((group) => local.has(group.id)).map((group) => group.id)
}

type ServerRow = {
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
}

/**
 * Source groups whose record the server's wins over this desktop's retained, perhaps stale, copy.
 * With the server's group list that is exactly the groups it holds: any other moves, so it is never
 * recorded as the server's. Without it, the groups the server's rows sit in and their ancestors,
 * less an ancestor a moving row needs, since the server may lack it.
 */
export function serverHeldProjectGroups(
  payload: Pick<
    OrcadMigrationCatalogPayload,
    'repositories' | 'folderWorkspaces' | 'projectGroups'
  >,
  linked: { repositoryIds: ReadonlySet<string>; folderWorkspaceIds: ReadonlySet<string> },
  server: readonly ServerRow[],
  serverGroups: Pick<OrcadServerFolderCatalog, 'projectGroups'> | undefined
): string[] {
  if (serverGroups) {
    return projectGroupsHeldByServer(payload.projectGroups, serverGroups)
  }
  const parentById = new Map(payload.projectGroups.map((group) => [group.id, group.parentGroupId]))
  const held = new Set(
    server
      .filter(isRepoOnCatalogHost)
      .flatMap((row) => (row.projectGroupId ? [row.projectGroupId] : []))
  )
  const withAncestors = (ids: (string | null | undefined)[], stopAt: ReadonlySet<string>) => {
    const out = new Set<string>()
    while (ids.length > 0) {
      const id = ids.pop()
      if (id && !out.has(id) && !stopAt.has(id) && parentById.has(id)) {
        out.add(id)
        ids.push(parentById.get(id))
      }
    }
    return out
  }
  const candidates = withAncestors([...held], new Set())
  const needed = withAncestors(
    [
      ...payload.repositories
        .filter((repo) => !linked.repositoryIds.has(repo.id))
        .map((repo) => repo.projectGroupId),
      ...payload.folderWorkspaces
        .filter((workspace) => !linked.folderWorkspaceIds.has(workspace.id))
        .map((workspace) => workspace.projectGroupId),
      ...payload.projectGroups
        .filter((group) => !candidates.has(group.id))
        .map((group) => group.parentGroupId)
    ],
    held
  )
  return [...candidates].filter((id) => !needed.has(id))
}
