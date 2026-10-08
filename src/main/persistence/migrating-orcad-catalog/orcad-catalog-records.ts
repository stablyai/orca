import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { assertOrcadMigrationStagedCatalogClaims } from './orcad-staged-catalog-claims'
import {
  toOrcadDestinationFolderWorkspace,
  toOrcadDestinationProjectGroup,
  toOrcadDestinationRepository
} from './orcad-destination-catalog-projection'
import {
  syncProjectHostSetupCompatibilityState,
  type RepoLifecycleOperations
} from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  applyPreparedOrcadMigrationDormantState,
  prepareOrcadMigrationDormantState,
  type PreparedOrcadMigrationDormantState
} from './orcad-dormant-state-records'
import { selectNewRows } from './orcad-catalog-row-identity'

export type PreparedOrcadMigrationCatalog = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  newRepositories: Repo[]
  newProjectGroups: ProjectGroup[]
  newFolderWorkspaces: FolderWorkspace[]
  dormantState: PreparedOrcadMigrationDormantState
}

export function assertSameOrcadMigrationManifest(
  staged: OrcadMigrationManifest,
  requested: OrcadMigrationManifest
): void {
  if (staged.manifestSha256 !== requested.manifestSha256) {
    throw new Error('orcad_migration_id_reused_with_different_manifest')
  }
}

// Dormant only: no live PTY reaches the destination, so the incoming session is compared as is.
export function prepareOrcadMigrationCatalog(
  manifest: OrcadMigrationManifest,
  state: StoreRuntimeState['state']
): PreparedOrcadMigrationCatalog {
  assertOrcadMigrationStagedCatalogClaims(manifest, state.orcadMigrationStagedCatalogs ?? [])
  const repositories = manifest.payload.repositories.map(toOrcadDestinationRepository)
  const projectGroups = manifest.payload.projectGroups.map(toOrcadDestinationProjectGroup)
  const folderWorkspaces = manifest.payload.folderWorkspaces.map(toOrcadDestinationFolderWorkspace)
  const newRepositories = selectNewRows(repositories, state.repos, catalogConflict('repository'))
  const newProjectGroups = selectNewRows(
    projectGroups,
    state.projectGroups,
    catalogConflict('project_group')
  )
  const newFolderWorkspaces = selectNewRows(
    folderWorkspaces,
    state.folderWorkspaces,
    catalogConflict('folder_workspace')
  )
  assertNoRepositoryPathConflicts(repositories, state.repos)
  assertCatalogReferences({
    repositories,
    projectGroups,
    folderWorkspaces,
    existingProjectGroups: state.projectGroups
  })
  const dormantState = prepareOrcadMigrationDormantState(manifest, state)
  return {
    repositories,
    projectGroups,
    folderWorkspaces,
    newRepositories,
    newProjectGroups,
    newFolderWorkspaces,
    dormantState
  }
}

export function applyPreparedOrcadMigrationCatalog(
  prepared: PreparedOrcadMigrationCatalog,
  state: StoreRuntimeState['state'],
  repos: RepoLifecycleOperations
): void {
  state.projectGroups.push(...prepared.newProjectGroups)
  state.repos.push(...prepared.newRepositories)
  state.folderWorkspaces.push(...prepared.newFolderWorkspaces)
  applyPreparedOrcadMigrationDormantState(prepared.dormantState, state)
  if (prepared.newRepositories.length > 0) {
    syncProjectHostSetupCompatibilityState(repos)
  }
}

export function assertOrcadMigrationReceiptMatchesManifest(
  receipt: OrcadMigrationImportReceipt,
  manifest: OrcadMigrationManifest
): void {
  const expected = {
    source: manifest.source,
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
    folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
  }
  const actual = {
    source: receipt.source,
    repositoryIds: receipt.repositoryIds,
    projectGroupIds: receipt.projectGroupIds,
    folderWorkspaceIds: receipt.folderWorkspaceIds
  }
  if (serializeOrcadMigrationValue(actual) !== serializeOrcadMigrationValue(expected)) {
    throw new Error('orcad_migration_receipt_manifest_mismatch')
  }
}

function catalogConflict(label: string): (id: string) => string {
  return (id) => `orcad_migration_${label}_id_conflict:${id}`
}

function assertNoRepositoryPathConflicts(incoming: Repo[], existing: Repo[]): void {
  const incomingIdSet = new Set(incoming.map((repo) => repo.id))
  const incomingByPath = new Map<string, string>()
  for (const repo of incoming) {
    const key = normalizeRuntimePathForComparison(repo.path)
    const priorId = incomingByPath.get(key)
    if (priorId && priorId !== repo.id) {
      throw new Error(`orcad_migration_repository_path_conflict:${repo.path}`)
    }
    incomingByPath.set(key, repo.id)
  }
  for (const repo of existing) {
    if (
      !incomingIdSet.has(repo.id) &&
      incomingByPath.has(normalizeRuntimePathForComparison(repo.path))
    ) {
      throw new Error(`orcad_migration_repository_path_conflict:${repo.path}`)
    }
  }
}

function assertCatalogReferences(args: {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  existingProjectGroups: ProjectGroup[]
}): void {
  const groupIds = new Set([
    ...args.existingProjectGroups.map((group) => group.id),
    ...args.projectGroups.map((group) => group.id)
  ])
  for (const group of args.projectGroups) {
    if (group.parentGroupId && !groupIds.has(group.parentGroupId)) {
      throw new Error(`orcad_migration_project_group_parent_missing:${group.id}`)
    }
  }
  for (const repo of args.repositories) {
    if (repo.projectGroupId && !groupIds.has(repo.projectGroupId)) {
      throw new Error(`orcad_migration_repository_project_group_missing:${repo.id}`)
    }
  }
  for (const workspace of args.folderWorkspaces) {
    if (!groupIds.has(workspace.projectGroupId)) {
      throw new Error(`orcad_migration_folder_workspace_project_group_missing:${workspace.id}`)
    }
  }
}
