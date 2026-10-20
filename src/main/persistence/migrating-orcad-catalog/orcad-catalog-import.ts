import { MAX_ORCAD_MIGRATION_STAGED_CATALOGS } from '../../../shared/orcad-migration/orcad-migration-staged-catalog-validation'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogReference,
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationImportReceipt,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationBlobChunkRequest,
  OrcadMigrationBlobChunkResult,
  OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  applyPreparedOrcadMigrationCatalog,
  assertOrcadMigrationReceiptMatchesManifest,
  assertSameOrcadMigrationManifest,
  prepareOrcadMigrationCatalog,
  type PreparedOrcadMigrationCatalog
} from './orcad-catalog-records'
import {
  expireOrcadMigrationStages,
  findOrcadMigrationImportReceipt,
  isLiveOrcadMigrationStage,
  recordOrcadMigrationCommitWriteGeneration,
  recordOrcadMigrationImportReceipt,
  type OrcadMigrationCommitGenerationRuntime
} from './orcad-catalog-receipt-ledger'
import {
  abortOrcadMigrationSnapshots,
  assertOrcadMigrationSnapshotsReady,
  commitOrcadMigrationSnapshots,
  inspectOrcadMigrationSnapshotUploads,
  pruneOrcadMigrationSnapshotStaging,
  stageOrcadMigrationSnapshotChunk
} from './orcad-scrollback-snapshot-transfer'
import {
  abortOrcadMigrationBlobs,
  assertOrcadMigrationBlobSetMatches,
  assertOrcadMigrationBlobsReady,
  commitOrcadMigrationBlobs,
  inspectOrcadMigrationBlobUploads,
  pruneOrcadMigrationBlobStaging,
  stageOrcadMigrationBlobChunk
} from './orcad-migration-blob-staging'
import { assertOrcadMigrationBlobContentsValid } from './orcad-migration-blob-installers'
import {
  abortOrcadMigrationCatalogByReference,
  committedMigrations,
  stagedManifests
} from './orcad-catalog-reference-abort'

type OrcadCatalogImportRuntime = OrcadMigrationCommitGenerationRuntime &
  Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage' | 'orcadMigrationBlobRoot'>

const orcadCatalogImportContext = Symbol('OrcadCatalogImportPersistence')
type OrcadCatalogImportContext = {
  runtime: OrcadCatalogImportRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

// Manifests arrive parsed; the RPC boundary verified the digest over the bytes as sent.
export class OrcadCatalogImportPersistence {
  readonly [orcadCatalogImportContext]: OrcadCatalogImportContext

  constructor(
    runtime: OrcadCatalogImportRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[orcadCatalogImportContext] = { runtime, repos, scheduling }
  }

  stageOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date } = {}
  ): OrcadMigrationCatalogState {
    const context = this[orcadCatalogImportContext]
    const now = options.now ?? (() => new Date())
    if (expireOrcadMigrationStages(context.runtime.state, now().getTime())) {
      scheduleSave(context.scheduling)
    }
    pruneOrcadMigrationSnapshotStaging(
      stagedManifests(context.runtime.state),
      context.runtime.terminalScrollbackSnapshotStorage
    )
    pruneOrcadMigrationBlobStaging(
      stagedManifests(context.runtime.state),
      committedMigrations(context.runtime.state),
      context.runtime.orcadMigrationBlobRoot
    )
    const current = migrationCatalogState(context.runtime, manifest)
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
    const stagedAt = now().toISOString()
    context.runtime.state.orcadMigrationStagedCatalogs = [
      ...staged,
      {
        version: ORCAD_MIGRATION_MANIFEST_VERSION,
        manifest: structuredClone(manifest),
        stagedAt
      }
    ]
    scheduleSave(context.scheduling)
    return stagedCatalogState(manifest, stagedAt, context.runtime)
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

  stageOrcadMigrationBlobChunk(
    request: OrcadMigrationBlobChunkRequest
  ): OrcadMigrationBlobChunkResult {
    const context = this[orcadCatalogImportContext]
    return stageOrcadMigrationBlobChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      root: context.runtime.orcadMigrationBlobRoot,
      request
    })
  }

  /** `expectedBlobs` absent (SSH, older senders) keeps the pre-blob-set commit unchanged. */
  commitStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { now?: () => Date; expectedBlobs?: readonly OrcadMigrationBlobDescriptor[] } = {}
  ): OrcadMigrationCatalogState {
    const context = this[orcadCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    if (current.state !== 'staged') {
      throw new Error('orcad_migration_catalog_not_staged')
    }
    const prepared = prepareOrcadMigrationCatalog(manifest, context.runtime.state)
    const blobRoot = context.runtime.orcadMigrationBlobRoot
    assertOrcadMigrationSnapshotsReady(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    if (options.expectedBlobs) {
      assertOrcadMigrationBlobSetMatches(manifest, blobRoot, options.expectedBlobs)
    }
    assertOrcadMigrationBlobsReady(manifest, blobRoot)
    assertOrcadMigrationBlobContentsValid(manifest, blobRoot)
    commitOrcadMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    commitOrcadMigrationBlobs(manifest, blobRoot)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    const generationBefore = context.runtime.writeGeneration
    scheduleSave(context.scheduling)
    recordOrcadMigrationCommitWriteGeneration(context.runtime, manifest, generationBefore)
    return committedCatalogState(receipt)
  }

  abortStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest
  ): OrcadMigrationCatalogAbortResult {
    const context = this[orcadCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed' || current.state === 'absent') {
      return { ...current, aborted: false }
    }
    // Dormant import only: nothing but this stage references the staged rows before commit.
    context.runtime.state.orcadMigrationStagedCatalogs = (
      context.runtime.state.orcadMigrationStagedCatalogs ?? []
    ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
    abortOrcadMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    abortOrcadMigrationBlobs(manifest, context.runtime.orcadMigrationBlobRoot)
    scheduleSave(context.scheduling)
    return { ...absentCatalogState(manifest), aborted: true }
  }

  /** For a source whose manifest no request can carry: this server's own copy stands in for it. */
  abortStagedOrcadMigrationCatalogByReference(
    reference: OrcadMigrationCatalogReference
  ): OrcadMigrationCatalogReferenceAbortResult {
    return abortOrcadMigrationCatalogByReference(
      this[orcadCatalogImportContext].runtime.state,
      reference,
      (manifest) => this.abortStagedOrcadMigrationCatalog(manifest)
    )
  }

  getOrcadMigrationCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
    const context = this[orcadCatalogImportContext]
    return migrationCatalogState(context.runtime, manifest)
  }

  /** A migration into this server staged recently and neither committed nor aborted. */
  hasStagedOrcadMigrationCatalog(now: number = Date.now()): boolean {
    return (this[orcadCatalogImportContext].runtime.state.orcadMigrationStagedCatalogs ?? []).some(
      (entry) => isLiveOrcadMigrationStage(entry.stagedAt, now)
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
  recordOrcadMigrationImportReceipt(context.runtime.state, receipt)
  return receipt
}

function migrationCatalogState(
  runtime: OrcadCatalogImportRuntime,
  manifest: OrcadMigrationManifest
): OrcadMigrationCatalogState {
  const { state } = runtime
  const receipt = findOrcadMigrationImportReceipt(state, manifest)
  if (receipt) {
    assertCommittedReceipt(receipt, manifest)
    return committedCatalogState(receipt)
  }
  const staged = state.orcadMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  if (!staged) {
    return absentCatalogState(manifest)
  }
  assertSameOrcadMigrationManifest(staged.manifest, manifest)
  return stagedCatalogState(manifest, staged.stagedAt, runtime)
}

/**
 * The receipt alone proves the commit: the server is live afterwards, so its rows and snapshot
 * files may legitimately change, and a later read must still say "committed".
 */
function assertCommittedReceipt(
  receipt: OrcadMigrationImportReceipt,
  manifest: OrcadMigrationManifest
): void {
  if (receipt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error('orcad_migration_id_reused_with_different_manifest')
  }
  assertOrcadMigrationReceiptMatchesManifest(receipt, manifest)
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
  runtime: OrcadCatalogImportRuntime
): OrcadMigrationCatalogState {
  const snapshotUploads = inspectOrcadMigrationSnapshotUploads(
    manifest,
    runtime.terminalScrollbackSnapshotStorage
  )
  // Absent, not empty, when nothing is staged: the shape an older host already answers with.
  const blobUploads = inspectOrcadMigrationBlobUploads(manifest, runtime.orcadMigrationBlobRoot)
  return {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt,
    ...(snapshotUploads ? { snapshotUploads } : {}),
    ...(blobUploads ? { blobUploads } : {})
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
