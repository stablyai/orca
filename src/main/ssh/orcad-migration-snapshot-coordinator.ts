import type { OrcadMigrationCatalogState } from '../../shared/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import {
  decodeOrcadMigrationSnapshotChunk,
  type OrcadMigrationSnapshotChunkRequest
} from '../../shared/orcad-migration-scrollback'
import type { Store } from '../persistence'
import type {
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationSnapshotChunk
} from './orcad-migration-catalog-client'

type SnapshotSourceStore = Pick<Store, 'readOrcadMigrationSourceSnapshotChunk'>

type SnapshotRemoteOperations = {
  read: typeof readRemoteOrcadMigrationCatalogState
  snapshot: typeof stageRemoteOrcadMigrationSnapshotChunk
}

type SnapshotRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export async function transferOrcadMigrationSnapshots(args: {
  store: SnapshotSourceStore
  cutover: OrcadMigrationSourceCutover
  pairingCode: string
  state: Extract<OrcadMigrationCatalogState, { state: 'staged' }>
  remote: SnapshotRemoteOperations
  requestOptions: SnapshotRequestOptions
}): Promise<void> {
  const snapshots = args.cutover.manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return
  }
  const offsets = new Map(
    (args.state.snapshotUploads ?? []).map((entry) => [entry.ref, entry.receivedBytes])
  )
  for (const snapshot of snapshots) {
    let offset = offsets.get(snapshot.ref)
    if (offset === undefined) {
      throw new Error('orcad_migration_snapshot_transfer_unsupported')
    }
    while (offset < snapshot.byteLength) {
      const source = args.store.readOrcadMigrationSourceSnapshotChunk(
        args.cutover.manifest.migrationId,
        snapshot.ref,
        offset
      )
      if (source.totalBytes !== snapshot.byteLength || !source.bytesBase64) {
        throw new Error('orcad_migration_source_snapshot_changed')
      }
      const request: OrcadMigrationSnapshotChunkRequest = {
        migrationId: args.cutover.manifest.migrationId,
        manifestSha256: args.cutover.manifest.manifestSha256,
        ref: snapshot.ref,
        offset,
        bytesBase64: source.bytesBase64
      }
      const expectedOffset = offset + decodeOrcadMigrationSnapshotChunk(source.bytesBase64).length
      offset = await stageSnapshotChunkWithRecovery(args, request, expectedOffset)
    }
  }
  const verified = await args.remote.read(
    args.pairingCode,
    args.cutover.manifest,
    args.requestOptions
  )
  if (
    verified.state !== 'staged' ||
    (verified.snapshotUploads ?? []).length !== snapshots.length ||
    (verified.snapshotUploads ?? []).some((entry) => entry.receivedBytes !== entry.byteLength)
  ) {
    throw new Error('orcad_migration_snapshot_transfer_incomplete')
  }
}

async function stageSnapshotChunkWithRecovery(
  args: {
    pairingCode: string
    cutover: OrcadMigrationSourceCutover
    remote: SnapshotRemoteOperations
    requestOptions: SnapshotRequestOptions
  },
  request: OrcadMigrationSnapshotChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await args.remote.snapshot(args.pairingCode, request, args.requestOptions)
    if (result.acknowledgedOffset !== expectedOffset) {
      throw new Error('orcad_migration_snapshot_ack_invalid')
    }
    return result.acknowledgedOffset
  } catch (error) {
    try {
      const observed = await args.remote.read(
        args.pairingCode,
        args.cutover.manifest,
        args.requestOptions
      )
      const received =
        observed.state === 'staged'
          ? observed.snapshotUploads?.find((entry) => entry.ref === request.ref)?.receivedBytes
          : undefined
      if (received === expectedOffset) {
        return received
      }
    } catch {
      // The chunk remains unverifiable; preserve the first failure and source fence.
    }
    throw error
  }
}
