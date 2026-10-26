import { z } from 'zod'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  resolveFolderWorkspaceHost,
  type FolderHostCatalog
} from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { listServerRows, type CatalogRequestOptions } from './orcad-migration-catalog-client'
import type { OrcadServerRepository } from './orcad-migration-repository-link'

/** Include groups because they can supply a folder's host. */
export type OrcadServerFolderCatalog = Omit<FolderHostCatalog, 'repos'>

const HostFields = { connectionId: z.string().nullish(), executionHostId: z.string().nullish() }

const ServerFolderWorkspacesSchema = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string().min(1),
      folderPath: z.string().min(1),
      projectGroupId: z.string().min(1),
      ...HostFields
    })
  )
})

const ServerProjectGroupsSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string().min(1),
      parentGroupId: z.string().nullish(),
      ...HostFields
    })
  )
})

export async function listRemoteOrcadFolderCatalog(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<OrcadServerFolderCatalog> {
  const [folders, groups] = await Promise.all([
    listServerRows(pairingCode, 'folderWorkspace.list', 'folder_workspaces', options),
    listServerRows(pairingCode, 'projectGroup.list', 'project_groups', options)
  ])
  return {
    folderWorkspaces: ServerFolderWorkspacesSchema.parse(folders).folderWorkspaces,
    projectGroups: ServerProjectGroupsSchema.parse(groups).groups.map((group) => ({
      ...group,
      parentGroupId: group.parentGroupId ?? null
    }))
  }
}

/** Link same-id/path folders only on the server's own host; other same-id rows still import and must conflict rather than alias. */
export function folderWorkspacesHeldByServer(
  incoming: readonly Pick<FolderWorkspace, 'id' | 'folderPath'>[],
  server: OrcadServerFolderCatalog,
  serverRepositories: readonly OrcadServerRepository[]
): string[] {
  const catalog = { ...server, repos: serverRepositories }
  const serverFolderById = new Map(
    server.folderWorkspaces.map((workspace) => [workspace.id, workspace.folderPath])
  )
  return incoming
    .filter((workspace) => {
      const serverFolder = serverFolderById.get(workspace.id)
      return (
        serverFolder !== undefined &&
        normalizeRuntimePathForComparison(serverFolder) ===
          normalizeRuntimePathForComparison(workspace.folderPath) &&
        // A row its group places on another host is a different folder, though stored bare.
        resolveFolderWorkspaceHost(catalog, workspace.id).kind === 'local'
      )
    })
    .map((workspace) => workspace.id)
}
