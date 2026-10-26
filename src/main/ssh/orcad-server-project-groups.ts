import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadServerFolderCatalog } from './orcad-server-folder-workspaces'

/** Same-id groups match only on the server's own host, even when empty. */
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

/** Prefer server-owned groups over retained copies. Without a group catalog, infer from server rows/ancestors but retain ancestors needed by moving rows: the server may lack them. */
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
