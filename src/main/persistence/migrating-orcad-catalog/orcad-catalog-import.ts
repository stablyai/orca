import {
  MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS,
  MAX_ORCAD_MIGRATION_STAGED_CATALOGS,
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationCatalogAbortResult,
  type OrcadMigrationCatalogState,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationImportResult,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../../shared/orcad-migration-scrollback'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  applyPreparedOrcadMigrationCatalog,
  assertCommittedOrcadMigrationCatalog,
  assertOrcadMigrationReceiptMatchesManifest,
  assertSameOrcadMigrationManifest,
  prepareOrcadMigrationCatalog,
  type PreparedOrcadMigrationCatalog
} from './orcad-catalog-records'
import {
  abortOrcadMigrationSnapshots,
  assertOrcadMigrationSnapshotsReady,
  commitOrcadMigrationSnapshots,
  inspectOrcadMigrationSnapshotUploads,
  pruneOrcadMigrationSnapshotStaging,
  stageOrcadMigrationSnapshotChunk
} from './orcad-scrollback-snapshot-transfer'

type OrcadCatalogImportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage'
>

const orcadCatalogImportContext = Symbol('OrcadCatalogImportPersistence')
type OrcadCatalogImportContext = {
  runtime: OrcadCatalogImportRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

export class OrcadCatalogImportPersistence {
  readonly [orcadCatalogImportContext]: OrcadCatalogImportContext

  constructor(
    runtime: OrcadCatalogImportRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[orcadCatalogImportContext] = { runtime, repos, scheduling }
  }

  importOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date } = {}
  ): OrcadMigrationImportResult {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadCatalogImportContext]
    const existingReceipt = findImportReceipt(context.runtime.state, manifest.migrationId)
    if (existingReceipt) {
      assertCommittedReceipt(
        existingReceipt,
        manifest,
        context.runtime.state,
        context.runtime.terminalScrollbackSnapshotStorage
      )
      return { status: 'already-imported', receipt: structuredClone(existingReceipt) }
    }
    if ((manifest.payload.dormantState?.terminalScrollbackSnapshots?.length ?? 0) > 0) {
      throw new Error('orcad_migration_snapshot_stage_required')
    }
    const prepared = prepareOrcadMigrationCatalog(manifest, context.runtime.state)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    scheduleSave(context.scheduling)
    return { status: 'imported', receipt: structuredClone(receipt) }
  }

  stageOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date } = {}
  ): OrcadMigrationCatalogState {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadCatalogImportContext]
    pruneOrcadMigrationSnapshotStaging(
      stagedManifests(context.runtime.state),
      context.runtime.terminalScrollbackSnapshotStorage
    )
    const current = migrationCatalogState(
      context.runtime.state,
      manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    if (current.state === 'committed') {
      return current
    }
    prepareOrcadMigrationCatalog(manifest, context.runtime.state)
    if (current.state === 'staged') {
      return current
    }
    const staged = context.runtime.state.orcadMigrationStagedCatalogs ?? []
    if (staged.length >= MAX_ORCAD_MIGRATION_STAGED_CATALOGS) {
      throw new Error('orcad_migration_staging_capacity_exceeded')
    }
    const stagedAt = (options.now ?? (() => new Date()))().toISOString()
    context.runtime.state.orcadMigrationStagedCatalogs = [
      ...staged,
      {
        version: ORCAD_MIGRATION_MANIFEST_VERSION,
        manifest: structuredClone(manifest),
        stagedAt
      }
    ]
    scheduleSave(context.scheduling)
    return stagedCatalogState(manifest, stagedAt, context.runtime.terminalScrollbackSnapshotStorage)
  }

  stageOrcadMigrationSnapshotChunk(
    request: OrcadMigrationSnapshotChunkRequest
  ): OrcadMigrationSnapshotChunkResult {
    const context = this[orcadCatalogImportContext]
    return stageOrcadMigrationSnapshotChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      storage: context.runtime.terminalScrollbackSnapshotStorage,
      request
    })
  }

  commitStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date } = {}
  ): OrcadMigrationCatalogState {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadCatalogImportContext]
    const current = migrationCatalogState(
      context.runtime.state,
      manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    if (current.state === 'committed') {
      return current
    }
    if (current.state !== 'staged') {
      throw new Error('orcad_migration_catalog_not_staged')
    }
    const prepared = prepareOrcadMigrationCatalog(manifest, context.runtime.state)
    assertOrcadMigrationSnapshotsReady(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    commitOrcadMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    scheduleSave(context.scheduling)
    return committedCatalogState(receipt)
  }

  abortStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest
  ): OrcadMigrationCatalogAbortResult {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadCatalogImportContext]
    const current = migrationCatalogState(
      context.runtime.state,
      manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    if (current.state === 'committed' || current.state === 'absent') {
      return { ...current, aborted: false }
    }
    // Dormant import only: nothing but this stage references the staged rows before commit.
    context.runtime.state.orcadMigrationStagedCatalogs = (
      context.runtime.state.orcadMigrationStagedCatalogs ?? []
    ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
    abortOrcadMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    scheduleSave(context.scheduling)
    return { ...absentCatalogState(manifest), aborted: true }
  }

  getOrcadMigrationCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadCatalogImportContext]
    return migrationCatalogState(
      context.runtime.state,
      manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
  }
}

function commitPreparedCatalog(
  context: OrcadCatalogImportContext,
  manifest: OrcadMigrationManifest,
  prepared: PreparedOrcadMigrationCatalog,
  now?: () => Date
): OrcadMigrationImportReceipt {
  applyPreparedOrcadMigrationCatalog(prepared, context.runtime.state, context.repos)
  const receipt: OrcadMigrationImportReceipt = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: structuredClone(manifest.source),
    importedAt: (now ?? (() => new Date()))().toISOString(),
    repositoryIds: prepared.repositories.map((repo) => repo.id),
    projectGroupIds: prepared.projectGroups.map((group) => group.id),
    folderWorkspaceIds: prepared.folderWorkspaces.map((workspace) => workspace.id)
  }
  context.runtime.state.orcadMigrationStagedCatalogs = (
    context.runtime.state.orcadMigrationStagedCatalogs ?? []
  ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
  context.runtime.state.orcadMigrationImportReceipts = [
    ...(context.runtime.state.orcadMigrationImportReceipts ?? []),
    receipt
  ].slice(-MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS)
  return receipt
}

function migrationCatalogState(
  state: StoreRuntimeState['state'],
  manifest: OrcadMigrationManifest,
  storage?: StoreRuntimeState['terminalScrollbackSnapshotStorage']
): OrcadMigrationCatalogState {
  const receipt = findImportReceipt(state, manifest.migrationId)
  if (receipt) {
    assertCommittedReceipt(receipt, manifest, state, storage)
    return committedCatalogState(receipt)
  }
  const staged = state.orcadMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  if (!staged) {
    return absentCatalogState(manifest)
  }
  assertSameOrcadMigrationManifest(staged.manifest, manifest)
  return stagedCatalogState(manifest, staged.stagedAt, storage)
}

function stagedManifests(state: StoreRuntimeState['state']): OrcadMigrationManifest[] {
  return (state.orcadMigrationStagedCatalogs ?? []).map((entry) => entry.manifest)
}

function findImportReceipt(
  state: StoreRuntimeState['state'],
  migrationId: string
): OrcadMigrationImportReceipt | undefined {
  return state.orcadMigrationImportReceipts?.find((receipt) => receipt.migrationId === migrationId)
}

function assertCommittedReceipt(
  receipt: OrcadMigrationImportReceipt,
  manifest: OrcadMigrationManifest,
  state: StoreRuntimeState['state'],
  storage?: StoreRuntimeState['terminalScrollbackSnapshotStorage']
): void {
  if (receipt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error('orcad_migration_id_reused_with_different_manifest')
  }
  assertOrcadMigrationReceiptMatchesManifest(receipt, manifest)
  assertCommittedOrcadMigrationCatalog(manifest, state)
  if (storage) {
    assertOrcadMigrationSnapshotsReady(manifest, storage)
  }
}

function absentCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
  return {
    state: 'absent',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  }
}

function stagedCatalogState(
  manifest: OrcadMigrationManifest,
  stagedAt: string,
  storage?: StoreRuntimeState['terminalScrollbackSnapshotStorage']
): OrcadMigrationCatalogState {
  const snapshotUploads = storage
    ? inspectOrcadMigrationSnapshotUploads(manifest, storage)
    : undefined
  return {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt,
    ...(snapshotUploads ? { snapshotUploads } : {})
  }
}

function committedCatalogState(receipt: OrcadMigrationImportReceipt): OrcadMigrationCatalogState {
  return {
    state: 'committed',
    migrationId: receipt.migrationId,
    manifestSha256: receipt.manifestSha256,
    receipt: structuredClone(receipt)
  }
}

export function installOrcadCatalogImportPersistenceContext(
  target: OrcadCatalogImportPersistence,
  source: OrcadCatalogImportPersistence
): void {
  Object.defineProperty(target, orcadCatalogImportContext, {
    value: source[orcadCatalogImportContext]
  })
}
