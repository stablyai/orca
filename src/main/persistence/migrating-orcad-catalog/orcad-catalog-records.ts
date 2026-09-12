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
import { resolveOrcadCatalogLiveProjection } from './orcad-catalog-live-projection'
import {
  syncProjectHostSetupCompatibilityState,
  type RepoLifecycleOperations
} from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  applyPreparedOrcadMigrationDormantState,
  assertCommittedOrcadMigrationDormantState,
  prepareOrcadMigrationDormantState,
  type PreparedOrcadMigrationDormantState
} from './orcad-dormant-state-records'

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

export function prepareOrcadMigrationCatalog(
  manifest: OrcadMigrationManifest,
  state: StoreRuntimeState['state'],
  storage?: Pick<StoreRuntimeState, 'dataFile' | 'terminalScrollbackSnapshotStorage'>
): PreparedOrcadMigrationCatalog {
  const projection = storage
    ? resolveOrcadCatalogLiveProjection(manifest, { ...storage, state }, true)
    : null
  if (projection) {
    state = { ...state, workspaceSession: projection.comparison }
  }
  assertOrcadMigrationStagedCatalogClaims(manifest, state.orcadMigrationStagedCatalogs ?? [])
  const repositories = manifest.payload.repositories.map(toOrcadDestinationRepository)
  const projectGroups = manifest.payload.projectGroups.map(toOrcadDestinationProjectGroup)
  const folderWorkspaces = manifest.payload.folderWorkspaces.map(toOrcadDestinationFolderWorkspace)
  const newRepositories = selectNewRows(repositories, state.repos, 'repository')
  const newProjectGroups = selectNewRows(projectGroups, state.projectGroups, 'project_group')
  const newFolderWorkspaces = selectNewRows(
    folderWorkspaces,
    state.folderWorkspaces,
    'folder_workspace'
  )
  assertNoRepositoryPathConflicts(repositories, state.repos)
  assertCatalogReferences({
    repositories,
    projectGroups,
    folderWorkspaces,
    existingProjectGroups: state.projectGroups
  })
  const dormantState = prepareOrcadMigrationDormantState(manifest, state)
  if (projection && dormantState.workspaceSession.merged) {
    dormantState.workspaceSession.merged = projection.restoreLiveOverlays(
      dormantState.workspaceSession.merged
    )
  }
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

export function assertCommittedOrcadMigrationCatalog(
  manifest: OrcadMigrationManifest,
  state: StoreRuntimeState['state'],
  storage?: Pick<StoreRuntimeState, 'dataFile' | 'terminalScrollbackSnapshotStorage'>
): void {
  let projection: ReturnType<typeof resolveOrcadCatalogLiveProjection> = null
  try {
    assertCommittedOrcadMigrationDormantState(manifest, state)
  } catch (error) {
    if (!storage) {
      throw error
    }
    projection = resolveOrcadCatalogLiveProjection(manifest, { ...storage, state }, false)
  }
  if (projection) {
    state = { ...state, workspaceSession: projection.comparison }
  }
  const repositories = manifest.payload.repositories.map(toOrcadDestinationRepository)
  const projectGroups = manifest.payload.projectGroups.map(toOrcadDestinationProjectGroup)
  const folderWorkspaces = manifest.payload.folderWorkspaces.map(toOrcadDestinationFolderWorkspace)
  assertRowsExist(repositories, state.repos, 'repository')
  assertRowsExist(projectGroups, state.projectGroups, 'project_group')
  assertRowsExist(folderWorkspaces, state.folderWorkspaces, 'folder_workspace')
  assertNoRepositoryPathConflicts(repositories, state.repos)
  assertCatalogReferences({
    repositories,
    projectGroups,
    folderWorkspaces,
    existingProjectGroups: state.projectGroups
  })
  assertCommittedOrcadMigrationDormantState(manifest, state)
}

export function toOrcadDestinationRepository(source: Repo): Repo {
  const destination = structuredClone(source)
  delete destination.connectionId
  delete destination.executionHostId
  return destination
}

export function toOrcadDestinationProjectGroup(source: ProjectGroup): ProjectGroup {
  const destination = structuredClone(source)
  destination.connectionId = null
  delete destination.executionHostId
  return destination
}

export function toOrcadDestinationFolderWorkspace(source: FolderWorkspace): FolderWorkspace {
  const destination = structuredClone(source)
  destination.connectionId = null
  delete destination.executionHostId
  destination.linkedTaskSourceContext ??= null
  return destination
}

function selectNewRows<T extends { id: string }>(incoming: T[], existing: T[], label: string): T[] {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  return incoming.filter((row) => {
    const current = existingById.get(row.id)
    if (!current) {
      return true
    }
    if (serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(row)) {
      throw new Error(`orcad_migration_${label}_id_conflict:${row.id}`)
    }
    return false
  })
}

function assertRowsExist<T extends { id: string }>(incoming: T[], existing: T[], label: string) {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  for (const row of incoming) {
    const current = existingById.get(row.id)
    if (!current || serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(row)) {
      throw new Error(`orcad_migration_receipt_catalog_mismatch:${label}:${row.id}`)
    }
  }
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
