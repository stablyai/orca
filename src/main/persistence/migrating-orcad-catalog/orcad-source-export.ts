// Export copies of relay-hosted SSH state without mutating source rows.
import {
  ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  type OrcadMigrationTerminalScrollbackSnapshot
} from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration/orcad-migration-manifest'
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
import { createOrcadMigrationLeaveBehindView } from './orcad-source-leave-behind-view'
import {
  collectOrcadMigrationSourceDrafts,
  type OrcadMigrationSourceDrafts
} from './orcad-source-draft-rename'

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

  collectOrcadMigrationSourceDrafts(manifest: OrcadMigrationManifest): OrcadMigrationSourceDrafts {
    return collectOrcadMigrationSourceDrafts(this[orcadSourceExportContext].state, manifest)
  }

  createOrcadMigrationDeltaView(moved: OrcadMigrationManifest): OrcadMigrationDeltaView {
    return createOrcadMigrationDeltaView(this[orcadSourceExportContext], moved)
  }

  /** Preview "Move anyway" without recording consent. */
  createOrcadMigrationLeaveBehindView(targetId: string): OrcadMigrationDeltaView {
    return createOrcadMigrationLeaveBehindView(this[orcadSourceExportContext], targetId)
  }

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

  /** Retain unfinished migrations' snapshots even if their tabs close. */
  syncOrcadMigrationScrollbackRetention(pending: readonly OrcadMigrationManifest[]): void {
    syncOrcadMigrationScrollbackRetention(this[orcadSourceExportContext], pending)
  }

  /** Verify snapshot bytes against the signed manifest so changed buffers cannot be transferred. */
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
