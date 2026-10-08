import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../../shared/repo-types'
import { ownerKeyBelongsToRepo } from '../../orca-profiles/profile-project-worktree-identity'
import { repoBelongsToOrcadSource } from './orcad-source-ownership'

export type OrcadMigrationSourceScope = {
  targetId: string
  targetGeneration: number | null
  hostId: ReturnType<typeof toSshExecutionHostId>
  repoIds: ReadonlySet<string>
  folderWorkspaceKeys: ReadonlySet<string>
  /**
   * Catalog repo ids another host registers too. A legacy unqualified key, or a bare repo id, for
   * one of these cannot say whose it is, so it never matches: it is neither moved nor subtracted.
   */
  sharedRepoIds: ReadonlySet<string>
  /** The session partition being read: an unqualified key there belongs to that partition's host. */
  partitionHostId?: string
}

/** The scope as seen from one session partition. */
export function orcadMigrationPartitionScope(
  scope: OrcadMigrationSourceScope,
  partitionHostId: string
): OrcadMigrationSourceScope {
  return { ...scope, partitionHostId }
}

export function createOrcadMigrationSourceScope(args: {
  source: OrcadMigrationManifestSource
  catalog: OrcadMigrationCatalogPayload
  /** The profile's repo rows, read for ids another host shares. */
  repos: readonly Repo[]
}): OrcadMigrationSourceScope {
  const repoIds = new Set(args.catalog.repositories.map((repo) => repo.id))
  return {
    targetId: args.source.sshTargetId,
    targetGeneration: args.source.sshTargetGeneration,
    hostId: toSshExecutionHostId(args.source.sshTargetId),
    repoIds,
    folderWorkspaceKeys: new Set(
      args.catalog.folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    ),
    sharedRepoIds: new Set(
      args.repos
        .filter(
          (repo) => repoIds.has(repo.id) && !repoBelongsToOrcadSource(repo, args.source.sshTargetId)
        )
        .map((repo) => repo.id)
    )
  }
}

/** A bare repo id the source owns alone; one another host shares cannot be attributed. */
export function orcadMigrationOwnsRepoId(
  scope: OrcadMigrationSourceScope,
  repoId: string | null | undefined
): boolean {
  return typeof repoId === 'string' && scope.repoIds.has(repoId) && !scope.sharedRepoIds.has(repoId)
}

/** `rowHostId` is the row's own host evidence, such as worktree metadata's `hostId`. */
export function orcadMigrationOwnerMatchesScope(
  value: string | null | undefined,
  scope: OrcadMigrationSourceScope,
  rowHostId?: string
): boolean {
  if (!value) {
    return false
  }
  // Why: a repo id may repeat across hosts; only the qualifier, the partition or the row says whose.
  const qualified = isWorktreeHostIdentity(value)
  const ownerHost = qualified
    ? getExecutionHostIdFromWorktreeHostIdentity(value)
    : scope.partitionHostId !== undefined && scope.partitionHostId !== LOCAL_EXECUTION_HOST_ID
      ? scope.partitionHostId
      : rowHostId
  if (ownerHost !== undefined && ownerHost !== scope.hostId) {
    return false
  }
  const rawValue = qualified ? getWorktreeIdFromHostIdentity(value) : value
  if (scope.folderWorkspaceKeys.has(rawValue)) {
    return true
  }
  for (const repoId of scope.repoIds) {
    if (ownerKeyBelongsToRepo(rawValue, repoId)) {
      return ownerHost !== undefined || !scope.sharedRepoIds.has(repoId)
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
