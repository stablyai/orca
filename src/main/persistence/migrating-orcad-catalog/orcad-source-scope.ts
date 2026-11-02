import {
  isOrcadMigrationLocalWslSource,
  requireOrcadMigrationSshSource
} from '../../../shared/orcad-migration/orcad-migration-source-kind'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../../shared/repo-types'
import { ownerKeyBelongsToRepo } from '../../orca-profiles/profile-project-worktree-identity'
import { repoBelongsToOrcadSource } from './orcad-source-ownership'

type OrcadMigrationScopeRows = {
  repoIds: ReadonlySet<string>
  folderWorkspaceKeys: ReadonlySet<string>
  /** Shared bare repo IDs cannot prove host ownership, so never move or subtract them. */
  sharedRepoIds: ReadonlySet<string>
  /** Unqualified keys inherit this partition's host. */
  partitionHostId?: string
}

/** A relay-era SSH target: its rows name the target, and live on the target's host id. */
export type OrcadMigrationSshSourceScope = OrcadMigrationScopeRows & {
  kind: 'ssh-relay'
  targetId: string
  targetGeneration: number | null
  hostId: ReturnType<typeof toSshExecutionHostId>
}

/** Local projects inside one WSL distro: rows live on host `local`, and no SSH target is involved. */
export type OrcadMigrationLocalWslSourceScope = OrcadMigrationScopeRows & {
  kind: 'local-wsl'
  targetId: null
  targetGeneration: null
  hostId: typeof LOCAL_EXECUTION_HOST_ID
}

export type OrcadMigrationSourceScope =
  | OrcadMigrationSshSourceScope
  | OrcadMigrationLocalWslSourceScope

/**
 * An SSH conversion moves every row its host holds, so an unmatched host row is an error. A WSL move
 * takes some of host `local`'s projects; the rest are another project's, never this move's.
 */
export function orcadMigrationScopeOwnsWholeHost(scope: OrcadMigrationSourceScope): boolean {
  return scope.kind === 'ssh-relay'
}

/** The scope as seen from one session partition. */
export function orcadMigrationPartitionScope<T extends OrcadMigrationSourceScope>(
  scope: T,
  partitionHostId: string
): T {
  return { ...scope, partitionHostId }
}

type OrcadMigrationScopeArgs = {
  source: OrcadMigrationManifestSource
  catalog: OrcadMigrationCatalogPayload
  /** Detect repo IDs shared by other hosts. */
  repos: readonly Repo[]
}

/** For the SSH conversion's own steps (census, subtraction): a WSL manifest reaching them throws. */
export function createOrcadMigrationSourceScope(
  args: OrcadMigrationScopeArgs
): OrcadMigrationSshSourceScope {
  const repoIds = new Set(args.catalog.repositories.map((repo) => repo.id))
  const source = requireOrcadMigrationSshSource(args.source)
  return {
    kind: 'ssh-relay',
    targetId: source.sshTargetId,
    targetGeneration: source.sshTargetGeneration,
    hostId: toSshExecutionHostId(source.sshTargetId),
    repoIds,
    folderWorkspaceKeys: new Set(
      args.catalog.folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    ),
    sharedRepoIds: new Set(
      args.repos
        .filter(
          (repo) => repoIds.has(repo.id) && !repoBelongsToOrcadSource(repo, source.sshTargetId)
        )
        .map((repo) => repo.id)
    )
  }
}

/** The scope the dormant-state export reads, for either source kind. */
export function createOrcadMigrationExportScope(
  args: OrcadMigrationScopeArgs
): OrcadMigrationSourceScope {
  if (!isOrcadMigrationLocalWslSource(args.source)) {
    return createOrcadMigrationSourceScope(args)
  }
  const repoIds = new Set(args.catalog.repositories.map((repo) => repo.id))
  return {
    kind: 'local-wsl',
    targetId: null,
    targetGeneration: null,
    hostId: LOCAL_EXECUTION_HOST_ID,
    repoIds,
    folderWorkspaceKeys: new Set(
      args.catalog.folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    ),
    // Another host registering the same repo id makes its unqualified keys ambiguous.
    sharedRepoIds: new Set(
      args.repos
        .filter(
          (repo) => repoIds.has(repo.id) && getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
        )
        .map((repo) => repo.id)
    )
  }
}

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
  // Repeated repo IDs require host proof from a qualifier, partition or row.
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

/**
 * An unqualified key naming a moved repo that another host also registers: it may be this move's
 * row or the other host's, so a WSL move can neither carry nor ignore what it owns.
 */
export function orcadMigrationOwnerKeyIsAmbiguous(
  value: string | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  if (!value || isWorktreeHostIdentity(value)) {
    return false
  }
  return [...scope.sharedRepoIds].some(
    (repoId) => scope.repoIds.has(repoId) && ownerKeyBelongsToRepo(value, repoId)
  )
}

export function unqualifyOrcadMigrationOwnerKey(value: string): string {
  return isWorktreeHostIdentity(value) ? getWorktreeIdFromHostIdentity(value) : value
}
