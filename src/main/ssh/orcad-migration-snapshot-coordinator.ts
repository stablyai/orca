/**
 * Sending a manifest's scrollback snapshots to the destination in bounded, resumable chunks.
 *
 * The source side only reads: each chunk comes from the profile-state store, checked against the
 * signed manifest's length and digest. The destination's catalog operations are passed in, so
 * this driver owns no transport and retires nothing. A chunk whose acknowledgement was lost is
 * confirmed by reading the destination's recorded offset, never assumed.
 */
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  decodeOrcadMigrationSnapshotChunk,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import type { Store } from '../persistence'

export type OrcadMigrationSnapshotSource = Pick<Store, 'readOrcadMigrationSourceSnapshotChunk'>

export type OrcadMigrationSnapshotDestination = {
  readState: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  stageChunk: (
    request: OrcadMigrationSnapshotChunkRequest
  ) => Promise<OrcadMigrationSnapshotChunkResult>
}

export async function transferOrcadMigrationSnapshots(args: {
  source: OrcadMigrationSnapshotSource
  manifest: OrcadMigrationManifest
  /** The destination's staged state, whose upload offsets say where each snapshot resumes. */
  state: Extract<OrcadMigrationCatalogState, { state: 'staged' }>
  destination: OrcadMigrationSnapshotDestination
}): Promise<void> {
  const snapshots = args.manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return
  }
  // The journal holds these bytes until commit or abort, so a closed tab still sends on a retry.
  await sendSnapshots(args, snapshots)
}

async function sendSnapshots(
  args: Parameters<typeof transferOrcadMigrationSnapshots>[0],
  snapshots: NonNullable<
    NonNullable<OrcadMigrationManifest['payload']['dormantState']>['terminalScrollbackSnapshots']
  >
): Promise<void> {
  const offsets = new Map(
    (args.state.snapshotUploads ?? []).map((entry) => [entry.ref, entry.receivedBytes])
  )
  for (const snapshot of snapshots) {
    let offset = offsets.get(snapshot.ref)
    if (offset === undefined) {
      throw new Error('orcad_migration_snapshot_transfer_unsupported')
    }
    while (offset < snapshot.byteLength) {
      const chunk = args.source.readOrcadMigrationSourceSnapshotChunk(
        args.manifest,
        snapshot.ref,
        offset
      )
      if (chunk.totalBytes !== snapshot.byteLength || !chunk.bytesBase64) {
        throw new Error('orcad_migration_source_snapshot_changed')
      }
      const request: OrcadMigrationSnapshotChunkRequest = {
        migrationId: args.manifest.migrationId,
        manifestSha256: args.manifest.manifestSha256,
        ref: snapshot.ref,
        offset,
        bytesBase64: chunk.bytesBase64
      }
      const expectedOffset = offset + decodeOrcadMigrationSnapshotChunk(chunk.bytesBase64).length
      offset = await stageChunkWithRecovery(args, request, expectedOffset)
    }
  }
  const verified = await args.destination.readState(args.manifest)
  if (
    verified.state !== 'staged' ||
    (verified.snapshotUploads ?? []).length !== snapshots.length ||
    (verified.snapshotUploads ?? []).some((entry) => entry.receivedBytes !== entry.byteLength)
  ) {
    throw new Error('orcad_migration_snapshot_transfer_incomplete')
  }
}

async function stageChunkWithRecovery(
  args: { manifest: OrcadMigrationManifest; destination: OrcadMigrationSnapshotDestination },
  request: OrcadMigrationSnapshotChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await args.destination.stageChunk(request)
    if (result.acknowledgedOffset !== expectedOffset) {
      throw new Error('orcad_migration_snapshot_ack_invalid')
    }
    return result.acknowledgedOffset
  } catch (error) {
    try {
      const observed = await args.destination.readState(args.manifest)
      const received =
        observed.state === 'staged'
          ? observed.snapshotUploads?.find((entry) => entry.ref === request.ref)?.receivedBytes
          : undefined
      if (received === expectedOffset) {
        return received
      }
    } catch {
      // The chunk stays unverifiable; report the first failure.
    }
    throw error
  }
}
