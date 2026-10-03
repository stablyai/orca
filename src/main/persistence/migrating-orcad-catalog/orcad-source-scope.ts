import { toSshExecutionHostId } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { ownerKeyBelongsToRepo } from '../../orca-profiles/profile-project-worktree-identity'

export type OrcadMigrationSourceScope = {
  targetId: string
  targetGeneration: number | null
  hostId: ReturnType<typeof toSshExecutionHostId>
  repoIds: ReadonlySet<string>
  folderWorkspaceKeys: ReadonlySet<string>
}

export function createOrcadMigrationSourceScope(args: {
  source: OrcadMigrationManifestSource
  catalog: OrcadMigrationCatalogPayload
}): OrcadMigrationSourceScope {
  return {
    targetId: args.source.sshTargetId,
    targetGeneration: args.source.sshTargetGeneration,
    hostId: toSshExecutionHostId(args.source.sshTargetId),
    repoIds: new Set(args.catalog.repositories.map((repo) => repo.id)),
    folderWorkspaceKeys: new Set(
      args.catalog.folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    )
  }
}

export function orcadMigrationOwnerMatchesScope(
  value: string | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  if (!value) {
    return false
  }
  const rawValue = isWorktreeHostIdentity(value) ? getWorktreeIdFromHostIdentity(value) : value
  if (scope.folderWorkspaceKeys.has(rawValue)) {
    return true
  }
  for (const repoId of scope.repoIds) {
    if (ownerKeyBelongsToRepo(rawValue, repoId)) {
      return true
    }
  }
  const parsed = parseWorkspaceKey(rawValue)
  return (
    parsed?.type === 'folder' && scope.folderWorkspaceKeys.has(`folder:${parsed.folderWorkspaceId}`)
  )
}

export function unqualifyOrcadMigrationOwnerKey(value: string): string {
  return isWorktreeHostIdentity(value) ? getWorktreeIdFromHostIdentity(value) : value
}
