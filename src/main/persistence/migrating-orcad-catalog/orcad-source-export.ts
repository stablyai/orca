/**
 * The Store's read-only view of a relay-hosted SSH target, for migrating it to a managed orcad.
 *
 * Everything here reads the profile-state store and returns copies; nothing writes or retires
 * source rows. Retiring the source after a verified import is the cutover's job (T8).
 */
import {
  ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  type OrcadMigrationTerminalScrollbackSnapshot
} from '../../../shared/orcad-migration-scrollback'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  collectOrcadMigrationSourceDependencyCensus,
  collectOrcadMigrationUntransferredDependencyCensus,
  type OrcadMigrationSourceDependencyCensus
} from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { readOrcadMigrationSourceScrollbackChunk } from './orcad-source-scrollback-state'

type OrcadSourceExportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

const orcadSourceExportContext = Symbol('OrcadSourceExportPersistence')

export class OrcadSourceExportPersistence {
  readonly [orcadSourceExportContext]: OrcadSourceExportRuntime

  constructor(runtime: OrcadSourceExportRuntime) {
    this[orcadSourceExportContext] = runtime
  }

  collectOrcadMigrationSourceDormantState(
    source: OrcadMigrationManifestSource,
    catalog: OrcadMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ): OrcadMigrationDormantStatePayload {
    const runtime = this[orcadSourceExportContext]
    return collectOrcadMigrationSourceDormantState(
      runtime.state,
      source,
      catalog,
      runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId
    ).payload
  }

  /** Every dependency on the target, transferable or not; preflight decides what blocks. */
  inspectOrcadMigrationSourceDependencies(
    manifest: OrcadMigrationManifest
  ): OrcadMigrationSourceDependencyCensus {
    const runtime = this[orcadSourceExportContext]
    return collectOrcadMigrationSourceDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    )
  }

  /** What still references the target that this manifest cannot carry. */
  inspectOrcadMigrationUntransferredDependencies(
    manifest: OrcadMigrationManifest
  ): OrcadMigrationSourceDependencyCensus {
    const runtime = this[orcadSourceExportContext]
    return collectOrcadMigrationUntransferredDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    )
  }

  /** Keeps the snapshot files this manifest names until released, even if their tabs close. */
  retainOrcadMigrationScrollback(manifest: OrcadMigrationManifest): void {
    const refs = (manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []).map(
      (snapshot) => snapshot.ref
    )
    this[orcadSourceExportContext].retainedScrollbackRefsByMigrationId.set(
      manifest.migrationId,
      new Set(refs)
    )
  }

  releaseOrcadMigrationScrollback(migrationId: string): void {
    this[orcadSourceExportContext].retainedScrollbackRefsByMigrationId.delete(migrationId)
  }

  /**
   * One bounded chunk of a scrollback snapshot the signed manifest names. The bytes are checked
   * against the manifest's length and digest, so a buffer that changed since export is refused.
   */
  readOrcadMigrationSourceSnapshotChunk(
    manifest: OrcadMigrationManifest,
    ref: string,
    offset: number
  ): { bytesBase64: string; totalBytes: number; eof: boolean } {
    assertOrcadMigrationManifestDigest(manifest)
    const descriptor: OrcadMigrationTerminalScrollbackSnapshot | undefined =
      manifest.payload.dormantState?.terminalScrollbackSnapshots?.find((entry) => entry.ref === ref)
    if (!descriptor) {
      throw new Error('orcad_migration_source_snapshot_unknown')
    }
    const runtime = this[orcadSourceExportContext]
    return readOrcadMigrationSourceScrollbackChunk({
      state: runtime.state,
      descriptor,
      offset,
      length: ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: runtime.terminalScrollbackSnapshotStorage
    })
  }
}

export function installOrcadSourceExportPersistenceContext(
  target: OrcadSourceExportPersistence,
  source: OrcadSourceExportPersistence
): void {
  Object.defineProperty(target, orcadSourceExportContext, {
    value: source[orcadSourceExportContext]
  })
}
