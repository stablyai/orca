/**
 * The server's record of which migrations it committed and which are still staged. A commit must
 * read as committed for as long as a client could ask, and an abandoned stage must not hold the
 * server awake or take a staging slot forever.
 */
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

// A client resumes a stage within minutes; a week only covers a host left offline meanwhile.
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
  // Everything else a receipt holds is the manifest's own: rebuilt, it still checks against it.
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

/** Appends a receipt; one that ages out of the bounded list keeps its commit as a compact record. */
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

/** Drops stages no client came back for; returns whether any went. */
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
  // A save suppressed by quit or maintenance never bumps the generation, so no in-process write
  // can prove this commit; only a restart that reads it from disk does.
  runtime.orcadMigrationCommitWriteGenerations.set(
    orcadMigrationStagingKey(migration),
    runtime.writeGeneration > generationBefore ? runtime.writeGeneration : Number.POSITIVE_INFINITY
  )
}

/**
 * Whether the receipt is on disk. A catalog-state query can see an in-memory receipt whose flush
 * failed; consuming its received blobs then would leave a retry after restart without them.
 */
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
  // Durable stays durable, so the entry is no longer needed.
  runtime.orcadMigrationCommitWriteGenerations.delete(key)
  return true
}
