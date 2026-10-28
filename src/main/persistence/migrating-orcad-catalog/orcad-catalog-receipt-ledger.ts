// Commit receipts remain authoritative indefinitely; abandoned stages expire.
import { MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationImportReceipt,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import { MAX_ORCAD_MIGRATION_EVICTED_RECEIPTS } from '../../../shared/orcad-migration/orcad-migration-evicted-receipts'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  orcadMigrationStagingKey,
  type OrcadMigrationRequestIdentity
} from './orcad-migration-staged-file'

// Allow a week for clients that went offline mid-move.
export const ORCAD_MIGRATION_STAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function findOrcadMigrationImportReceipt(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): OrcadMigrationImportReceipt | undefined {
  const receipt = state.orcadMigrationImportReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  if (receipt) {
    return receipt
  }
  const evicted = state.orcadMigrationEvictedReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  // Rebuild the remaining receipt fields from the manifest.
  return evicted
    ? {
        version: manifest.version,
        migrationId: evicted.migrationId,
        manifestSha256: evicted.manifestSha256,
        source: structuredClone(manifest.source),
        importedAt: evicted.importedAt,
        repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
        projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
        folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
      }
    : undefined
}

/** Compact evicted receipts without losing proof of commit. */
export function recordOrcadMigrationImportReceipt(
  state: PersistedState,
  receipt: OrcadMigrationImportReceipt
): void {
  const receipts = [...(state.orcadMigrationImportReceipts ?? []), receipt]
  const overflow = receipts.length - MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS
  if (overflow > 0) {
    state.orcadMigrationEvictedReceipts = [
      ...(state.orcadMigrationEvictedReceipts ?? []),
      ...receipts.slice(0, overflow).map(({ migrationId, manifestSha256, importedAt }) => ({
        migrationId,
        manifestSha256,
        importedAt
      }))
    ].slice(-MAX_ORCAD_MIGRATION_EVICTED_RECEIPTS)
  }
  state.orcadMigrationImportReceipts = receipts.slice(-MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS)
}

export function isLiveOrcadMigrationStage(stagedAt: string, now: number): boolean {
  return now - Date.parse(stagedAt) < ORCAD_MIGRATION_STAGE_TTL_MS
}

export function expireOrcadMigrationStages(state: PersistedState, now: number): boolean {
  const staged = state.orcadMigrationStagedCatalogs ?? []
  const live = staged.filter((entry) => isLiveOrcadMigrationStage(entry.stagedAt, now))
  if (live.length === staged.length) {
    return false
  }
  state.orcadMigrationStagedCatalogs = live
  return true
}

export type OrcadMigrationCommitGenerationRuntime = Pick<
  StoreRuntimeState,
  'writeGeneration' | 'lastDurableWriteGeneration' | 'orcadMigrationCommitWriteGenerations'
>

/** Call right after the commit's `scheduleSave`; `generationBefore` is read just before it. */
export function recordOrcadMigrationCommitWriteGeneration(
  runtime: OrcadMigrationCommitGenerationRuntime,
  migration: OrcadMigrationRequestIdentity,
  generationBefore: number
): void {
  // Suppressed saves never advance generation; only a disk-loaded receipt can prove durability.
  runtime.orcadMigrationCommitWriteGenerations.set(
    orcadMigrationStagingKey(migration),
    runtime.writeGeneration > generationBefore ? runtime.writeGeneration : Number.POSITIVE_INFINITY
  )
}

/** Require disk durability before consuming blobs a restart might need to retry. */
export function isOrcadMigrationCommitDurable(
  runtime: OrcadMigrationCommitGenerationRuntime,
  migration: OrcadMigrationRequestIdentity
): boolean {
  const key = orcadMigrationStagingKey(migration)
  const required = runtime.orcadMigrationCommitWriteGenerations.get(key)
  if (required === undefined) {
    return true
  }
  if (runtime.lastDurableWriteGeneration < required) {
    return false
  }
  runtime.orcadMigrationCommitWriteGenerations.delete(key)
  return true
}
