import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type {
  OrcadMigrationManifest,
  OrcadMigrationStagedCatalog
} from '../../../shared/orcad-migration-manifest'
import { collectOrcadMigrationSessionEntityOwners } from './orcad-destination-workspace-session'

export function assertOrcadMigrationStagedCatalogClaims(
  manifest: OrcadMigrationManifest,
  staged: readonly OrcadMigrationStagedCatalog[]
): void {
  const requested = catalogClaims(manifest)
  for (const entry of staged) {
    if (entry.manifest.migrationId === manifest.migrationId) {
      if (entry.manifest.manifestSha256 !== manifest.manifestSha256) {
        throw new Error('orcad_migration_id_reused_with_different_manifest')
      }
      continue
    }
    for (const claim of catalogClaims(entry.manifest)) {
      if (requested.has(claim)) {
        throw new Error(`orcad_migration_staged_claim_conflict:${claim}`)
      }
    }
  }
}

function catalogClaims(manifest: OrcadMigrationManifest): Set<string> {
  const { payload } = manifest
  const claims = new Set<string>()
  for (const repo of payload.repositories) {
    claims.add(`repository:${repo.id}`)
    claims.add(`repository-path:${normalizeRuntimePathForComparison(repo.path)}`)
  }
  payload.projectGroups.forEach((group) => claims.add(`project-group:${group.id}`))
  payload.folderWorkspaces.forEach((folder) => claims.add(`folder-workspace:${folder.id}`))
  const dormant = payload.dormantState
  if (dormant) {
    dormant.worktreeMeta.forEach((entry) => claims.add(`worktree-meta:${entry.worktreeId}`))
    dormant.worktreeLineage.forEach((entry) => claims.add(`worktree-lineage:${entry.worktreeId}`))
    dormant.workspaceLineage.forEach((entry) =>
      claims.add(`workspace-lineage:${entry.childWorkspaceKey}`)
    )
    dormant.sparsePresets.forEach((preset) =>
      claims.add(`sparse-preset:${preset.repoId}:${preset.id}`)
    )
    dormant.automations?.forEach((automation) => claims.add(`automation:${automation.id}`))
    dormant.automationRuns?.forEach((run) => claims.add(`automation-run:${run.id}`))
    if (dormant.workspaceSession) {
      for (const tabId of Object.keys(dormant.workspaceSession.terminalLayoutsByTabId)) {
        claims.add(`session:terminal-layout:${tabId}`)
      }
      for (const entity of collectOrcadMigrationSessionEntityOwners(
        dormant.workspaceSession
      ).keys()) {
        claims.add(`session:${entity}`)
      }
    }
  }
  return claims
}
