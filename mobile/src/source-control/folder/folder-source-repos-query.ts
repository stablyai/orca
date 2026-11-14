import type { Repo } from '../../../../src/shared/repo-types'
import type { ProjectGroup } from '../../../../src/shared/project-group-types'
import { getFolderSourceRepos } from '../../../../src/shared/folder-workspaces/folder-workspace-source-repos'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../../src/shared/execution-host'
import { defineHostQuery } from '../../query/host-query'
import type { HostQueryTarget } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { hostProjectGroupsRead } from '../../worktree/project-sections/project-sections-operations'
import { listHostRepos, listServerRepos } from '../../worktree/repositories/server-repos'

export type FolderSourceCatalog = { repos: Repo[]; groups: ProjectGroup[] }

const NO_REPOS: Repo[] = []

const fetchFolderSourceCatalog = async (
  client: RpcClient,
  target: HostQueryTarget
): Promise<FolderSourceCatalog> => {
  const server = target.exec === LOCAL_EXECUTION_HOST_ID ? null : target.exec
  const [repos, groupsRead] = await Promise.all([
    server ? listServerRepos<Repo>(server, client) : listHostRepos<Repo>(client),
    hostProjectGroupsRead.request(client).then((reply) => hostProjectGroupsRead.interpret(reply))
  ])
  if (!repos || !groupsRead.accepted) {
    throw new Error('Folder repositories unavailable')
  }
  // Repos from a server come stamped with it; its groups must match, or the host check drops every repo.
  const groups = server
    ? groupsRead.value.map((group) => ({ ...group, executionHostId: server }))
    : groupsRead.value
  return { repos, groups }
}

/** The paired desktop's own repositories and project groups, re-read when its repos change. */
export const folderSourceCatalogQuery = defineHostQuery<Record<string, never>, FolderSourceCatalog>(
  {
    family: 'folder.sourceCatalog',
    fetch: fetchFolderSourceCatalog,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    signal: { events: ['reposChanged'] }
  }
)

// A relayed server's changes are not signalled, so its reads hold no event stream; focus and refresh read again.
export const serverFolderSourceCatalogQuery = defineHostQuery<
  Record<string, never>,
  FolderSourceCatalog
>({
  family: 'folder.sourceCatalog.server',
  fetch: fetchFolderSourceCatalog,
  staleTime: 60_000,
  refetchOnWindowFocus: true
})

/** The folder's repositories a worktree can be created in, as desktop's empty state lists them. */
export function selectFolderSourceRepos(
  catalog: FolderSourceCatalog | undefined,
  projectGroupId: string | null
): Repo[] {
  if (!catalog || !projectGroupId) {
    return NO_REPOS
  }
  const group = catalog.groups.find((candidate) => candidate.id === projectGroupId) ?? null
  // Direct SSH hosts can't create worktrees from here (managed hosts route as runtimes).
  return getFolderSourceRepos(catalog.repos, catalog.groups, group).filter(
    (repo) => !getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
  )
}
