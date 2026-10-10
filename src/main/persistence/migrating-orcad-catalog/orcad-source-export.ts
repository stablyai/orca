/**
 * The Store's read-only view of a relay-hosted SSH target, for migrating it to a managed orcad.
 *
 * Everything here reads the profile-state store and returns copies; nothing writes or deletes
 * source rows, and nothing else deletes them after an import either.
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
  collectOrcadMigrationUntransferredDependencyCensus,
  type OrcadMigrationSourceDependencyCensus
} from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { readOrcadMigrationSourceScrollbackChunk } from './orcad-source-scrollback-state'
import {
  createOrcadMigrationDeltaView,
  type OrcadMigrationDeltaView
} from './orcad-source-delta-view'
import { syncOrcadMigrationScrollbackRetention } from './orcad-source-scrollback-retention'

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

  /** A copy of the source with `moved` subtracted from it, for a delta move. */
  createOrcadMigrationDeltaView(moved: OrcadMigrationManifest): OrcadMigrationDeltaView {
    return createOrcadMigrationDeltaView(this[orcadSourceExportContext], moved)
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

  /** Holds the snapshots unfinished migrations name; see syncOrcadMigrationScrollbackRetention. */
  syncOrcadMigrationScrollbackRetention(pending: readonly OrcadMigrationManifest[]): void {
    syncOrcadMigrationScrollbackRetention(this[orcadSourceExportContext], pending)
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
      retained: [...runtime.retainedScrollbackRefsByMigrationId.values()].some((refs) =>
        refs.has(ref)
      ),
      offset,
      length: ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: runtime.terminalScrollbackSnapshotStorage
    })
  }
}
