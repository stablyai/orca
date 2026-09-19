import type { OrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { recordOrcadSourceLiveProgress } from './orcad-source-live-progress'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationCatalogPayload,
  type OrcadMigrationCatalogState,
  type OrcadMigrationManifest,
  type OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import type { ProjectCollectionOperations } from '../loading-store/project-collection-operations'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import {
  collectOrcadMigrationSourceDependencyCensus,
  type OrcadMigrationSourceDependencyCensus
} from './orcad-source-dependency-census'
import {
  collectOrcadMigrationSourceDormantState,
  retireOrcadMigrationSourceDormantState
} from './orcad-source-dormant-state'
import { readOrcadMigrationSourceScrollbackChunk } from './orcad-source-scrollback-state'
import { ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES } from '../../../shared/orcad-migration-scrollback'
import {
  assertDestinationStateIdentity,
  assertSourceCatalogRetired,
  assertSourceCatalogUnchanged,
  assertSourceDependenciesAbsent,
  assertSourceDependenciesRetired,
  replaceCutover,
  requireCutover,
  requireSourceFence
} from './orcad-source-cutover-validation'
import { findCutover } from './orcad-source-cutover-validation'
import { retireSourceCatalogRows } from './orcad-source-cutover-retirement'
import {
  beginOrcadMigrationSourceCutover,
  beginOrcadLiveSourceCutover,
  releaseOrcadMigrationSourceCutover
} from './orcad-source-cutover-admission'
import type {
  OrcadSourceCutoverContext,
  OrcadSourceCutoverRuntime
} from './orcad-source-cutover-context'
import type { OrcadSourceLiveProjection } from './orcad-source-cutover-context'

const orcadSourceCutoverContext = Symbol('OrcadSourceCutoverPersistence')

export type OrcadMigrationSourceReleaseEvidence =
  | {
      kind: 'catalog-absent'
      state: Extract<OrcadMigrationCatalogState, { state: 'absent' }>
    }
  | { kind: 'stage-method-unsupported' }

export class OrcadSourceCutoverPersistence {
  readonly [orcadSourceCutoverContext]: OrcadSourceCutoverContext

  constructor(
    runtime: OrcadSourceCutoverRuntime,
    projects: ProjectCollectionOperations,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[orcadSourceCutoverContext] = { runtime, projects, repos, scheduling }
  }

  listOrcadMigrationSourceCutovers(): OrcadMigrationSourceCutover[] {
    return structuredClone(
      this[orcadSourceCutoverContext].runtime.state.orcadMigrationSourceCutovers ?? []
    )
  }

  /** Caller authenticates destination observations and flushes before acknowledging progress. */
  recordOrcadLiveCutoverProgress(migrationId: string, expected: unknown, next: unknown) {
    return recordOrcadSourceLiveProgress(
      this[orcadSourceCutoverContext],
      migrationId,
      expected,
      next
    )
  }

  collectOrcadMigrationSourceDormantState(
    source: OrcadMigrationManifestSource,
    catalog: OrcadMigrationCatalogPayload,
    destinationEnvironmentId?: string,
    projectLiveSource?: OrcadSourceLiveProjection
  ) {
    const runtime = this[orcadSourceCutoverContext].runtime
    const comparison = projectLiveSource
      ? projectLiveSource(structuredClone(runtime.state), source, catalog)
      : runtime.state
    return collectOrcadMigrationSourceDormantState(
      comparison,
      source,
      catalog,
      this[orcadSourceCutoverContext].runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId
    ).payload
  }

  readOrcadMigrationSourceSnapshotChunk(
    migrationId: string,
    ref: string,
    offset: number
  ): { bytesBase64: string; totalBytes: number; eof: boolean } {
    const context = this[orcadSourceCutoverContext]
    const cutover = findCutover(context.runtime.state, migrationId)
    if (!cutover) {
      throw new Error('orcad_migration_source_cutover_not_found')
    }
    requireSourceFence(context.runtime.state, cutover)
    const descriptor = cutover.manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
      (entry) => entry.ref === ref
    )
    if (!descriptor) {
      throw new Error('orcad_migration_source_snapshot_unknown')
    }
    return readOrcadMigrationSourceScrollbackChunk({
      state: context.runtime.state,
      descriptor,
      offset,
      length: ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: context.runtime.terminalScrollbackSnapshotStorage
    })
  }

  getOrcadMigrationSourceCutover(migrationId: string): OrcadMigrationSourceCutover | null {
    const cutover = this[
      orcadSourceCutoverContext
    ].runtime.state.orcadMigrationSourceCutovers?.find(
      (entry) => entry.manifest.migrationId === migrationId
    )
    return cutover ? structuredClone(cutover) : null
  }

  beginOrcadMigrationSourceCutover(
    manifest: OrcadMigrationManifest,
    destinationEnvironmentId: string,
    options: { destinationName?: string; now?: () => Date } = {}
  ): OrcadMigrationSourceCutover {
    return beginOrcadMigrationSourceCutover(
      this[orcadSourceCutoverContext],
      manifest,
      destinationEnvironmentId,
      options
    )
  }

  /** Caller retains intent durably first and holds authenticated source projection authority. */
  beginOrcadLiveSourceCutover(value: unknown, project: OrcadSourceLiveProjection) {
    return beginOrcadLiveSourceCutover(this[orcadSourceCutoverContext], value, project)
  }

  assertOrcadMigrationSourceCatalogUnchanged(migrationId: string): void {
    const context = this[orcadSourceCutoverContext]
    const cutover = requireCutover(context.runtime.state, migrationId)
    requireSourceFence(context.runtime.state, cutover)
    assertSourceCatalogUnchanged(context.projects, cutover.manifest)
  }

  getOrcadMigrationSourceDependencyCensus(
    migrationId: string
  ): OrcadMigrationSourceDependencyCensus {
    const context = this[orcadSourceCutoverContext]
    const cutover = requireCutover(context.runtime.state, migrationId)
    requireSourceFence(context.runtime.state, cutover)
    return collectOrcadMigrationSourceDependencyCensus(
      context.runtime.state,
      cutover.manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
  }

  inspectOrcadMigrationSourceDependencies(
    manifest: OrcadMigrationManifest,
    projectLiveSource?: OrcadSourceLiveProjection
  ): OrcadMigrationSourceDependencyCensus {
    assertOrcadMigrationManifestDigest(manifest)
    assertSourceCatalogUnchanged(this[orcadSourceCutoverContext].projects, manifest)
    return collectOrcadMigrationSourceDependencyCensus(
      projectLiveSource
        ? projectLiveSource(
            structuredClone(this[orcadSourceCutoverContext].runtime.state),
            manifest.source,
            manifest.payload
          )
        : this[orcadSourceCutoverContext].runtime.state,
      manifest,
      this[orcadSourceCutoverContext].runtime.terminalScrollbackSnapshotStorage
    )
  }

  assertOrcadMigrationSourceDependenciesAbsent(migrationId: string): void {
    const context = this[orcadSourceCutoverContext]
    const cutover = requireCutover(context.runtime.state, migrationId)
    requireSourceFence(context.runtime.state, cutover)
    assertSourceDependenciesAbsent(context.runtime, cutover.manifest)
  }

  markOrcadMigrationDestinationStaged(
    migrationId: string,
    destinationState: Extract<OrcadMigrationCatalogState, { state: 'staged' }>,
    options: { now?: () => Date } = {}
  ): OrcadMigrationSourceCutover {
    const context = this[orcadSourceCutoverContext]
    const current = requireCutover(context.runtime.state, migrationId)
    assertDestinationStateIdentity(current, destinationState)
    requireSourceFence(context.runtime.state, current)
    if (current.phase === 'source-retired') {
      assertSourceCatalogRetired(context.runtime.state, current.manifest)
      assertSourceDependenciesRetired(context.runtime, current.manifest)
      return structuredClone(current)
    }
    assertSourceCatalogUnchanged(context.projects, current.manifest)
    assertSourceDependenciesAbsent(context.runtime, current.manifest)
    if (current.phase === 'destination-committed') {
      return structuredClone(current)
    }
    if (current.phase === 'destination-staged' && current.stagedAt !== destinationState.stagedAt) {
      throw new Error('orcad_migration_destination_stage_identity_changed')
    }
    const next: OrcadMigrationSourceCutover = {
      ...current,
      phase: 'destination-staged',
      stagedAt: destinationState.stagedAt,
      updatedAt: (options.now ?? (() => new Date()))().toISOString()
    }
    return structuredClone(replaceCutover(context, next))
  }

  markOrcadMigrationDestinationCommitted(
    migrationId: string,
    destinationState: Extract<OrcadMigrationCatalogState, { state: 'committed' }>,
    options: { now?: () => Date } = {}
  ): OrcadMigrationSourceCutover {
    const context = this[orcadSourceCutoverContext]
    const current = requireCutover(context.runtime.state, migrationId)
    assertDestinationStateIdentity(current, destinationState)
    requireSourceFence(context.runtime.state, current)
    if (
      (current.phase === 'destination-committed' || current.phase === 'source-retired') &&
      serializeOrcadMigrationValue(current.receipt) !==
        serializeOrcadMigrationValue(destinationState.receipt)
    ) {
      throw new Error('orcad_migration_destination_receipt_changed')
    }
    if (current.phase === 'source-retired') {
      assertSourceCatalogRetired(context.runtime.state, current.manifest)
      assertSourceDependenciesRetired(context.runtime, current.manifest)
      return structuredClone(current)
    }
    const next: OrcadMigrationSourceCutover = {
      ...current,
      phase: 'destination-committed',
      receipt: structuredClone(destinationState.receipt),
      updatedAt: (options.now ?? (() => new Date()))().toISOString()
    }
    return structuredClone(replaceCutover(context, next))
  }

  retireOrcadMigrationSourceCatalog(
    migrationId: string,
    options: { now?: () => Date } = {}
  ): OrcadMigrationSourceCutover {
    const context = this[orcadSourceCutoverContext]
    const current = requireCutover(context.runtime.state, migrationId)
    requireSourceFence(context.runtime.state, current)
    if (current.phase === 'source-retired') {
      assertSourceCatalogRetired(context.runtime.state, current.manifest)
      assertSourceDependenciesRetired(context.runtime, current.manifest)
      return structuredClone(current)
    }
    if (current.phase !== 'destination-committed') {
      throw new Error('orcad_migration_destination_not_committed')
    }
    assertSourceCatalogUnchanged(context.projects, current.manifest)
    assertSourceDependenciesAbsent(context.runtime, current.manifest)
    const timestamp = (options.now ?? (() => new Date()))().toISOString()
    const next: OrcadMigrationSourceCutover = {
      ...current,
      phase: 'source-retired',
      retiredAt: timestamp,
      updatedAt: timestamp
    }
    retireOrcadMigrationSourceDormantState(context.runtime.state, current.manifest)
    retireSourceCatalogRows(context, current.manifest)
    return structuredClone(replaceCutover(context, next))
  }

  releaseOrcadMigrationSourceCutover(
    migrationId: string,
    evidence: OrcadMigrationSourceReleaseEvidence
  ): void {
    releaseOrcadMigrationSourceCutover(this[orcadSourceCutoverContext], migrationId, evidence)
  }
}

export function installOrcadSourceCutoverPersistenceContext(
  target: object,
  source: OrcadSourceCutoverPersistence
): void {
  Object.defineProperty(target, orcadSourceCutoverContext, {
    value: source[orcadSourceCutoverContext]
  })
}
