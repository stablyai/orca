/**
 * Sending a migration's blobs to the destination in bounded, resumable chunks, beside the
 * manifest's scrollback snapshots. Every kind is checked against the destination's capabilities
 * before the first byte: a kind it cannot install is refused by name, never dropped. Offsets
 * resume from the destination's staged state, and a lost acknowledgement is confirmed by
 * re-reading that state, never assumed.
 */
import {
  ORCAD_MIGRATION_BLOB_CHUNK_BYTES,
  type OrcadMigrationBlobChunkRequest,
  type OrcadMigrationBlobChunkResult,
  type OrcadMigrationBlobDescriptor,
  assertOrcadMigrationBlobSet,
  findUnsupportedMigrationBlobKind,
  orcadMigrationBlobIdentity,
  orcadMigrationBlobKindUnsupportedBlocker,
  sameOrcadMigrationBlob
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'

export type OrcadMigrationBlobSource = {
  /** Up to `maxBytes` bytes of the blob starting at `offset`, exactly as the descriptor hashed. */
  readChunk: (
    descriptor: OrcadMigrationBlobDescriptor,
    offset: number,
    maxBytes: number
  ) => Promise<Buffer>
}

export type OrcadMigrationBlobDestination = {
  readCapabilities: () => Promise<readonly string[]>
  readState: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  stageChunk: (request: OrcadMigrationBlobChunkRequest) => Promise<OrcadMigrationBlobChunkResult>
}

export type OrcadMigrationBlobTransfer = {
  source: OrcadMigrationBlobSource
  manifest: OrcadMigrationManifest
  blobs: readonly OrcadMigrationBlobDescriptor[]
  destination: OrcadMigrationBlobDestination
}

type StagedCatalogState = Extract<OrcadMigrationCatalogState, { state: 'staged' }>

export async function transferOrcadMigrationBlobs(
  transfer: OrcadMigrationBlobTransfer
): Promise<void> {
  if (transfer.blobs.length === 0) {
    return
  }
  assertOrcadMigrationBlobSet(transfer.blobs)
  const unsupported = findUnsupportedMigrationBlobKind(
    transfer.blobs,
    await transfer.destination.readCapabilities()
  )
  if (unsupported) {
    throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
  }
  const offsets = receivedOffsets(transfer, await readStagedState(transfer))
  for (const blob of transfer.blobs) {
    let offset = offsets.get(orcadMigrationBlobIdentity(blob)) ?? 0
    while (offset < blob.byteLength) {
      const bytes = await transfer.source.readChunk(
        blob,
        offset,
        Math.min(ORCAD_MIGRATION_BLOB_CHUNK_BYTES, blob.byteLength - offset)
      )
      if (
        bytes.length === 0 ||
        bytes.length > ORCAD_MIGRATION_BLOB_CHUNK_BYTES ||
        offset + bytes.length > blob.byteLength
      ) {
        throw new Error(`orcad_migration_source_blob_changed:${blob.blobKind}`)
      }
      const request: OrcadMigrationBlobChunkRequest = {
        migrationId: transfer.manifest.migrationId,
        manifestSha256: transfer.manifest.manifestSha256,
        blob: { ...blob },
        offset,
        bytesBase64: bytes.toString('base64')
      }
      offset = await stageChunkWithRecovery(transfer, request, offset + bytes.length)
    }
  }
  assertAllReceived(transfer, await readStagedState(transfer))
}

async function readStagedState(transfer: OrcadMigrationBlobTransfer): Promise<StagedCatalogState> {
  const state = await transfer.destination.readState(transfer.manifest)
  if (state.state !== 'staged') {
    throw new Error('orcad_migration_blob_catalog_not_staged')
  }
  return state
}

function receivedOffsets(
  transfer: OrcadMigrationBlobTransfer,
  state: StagedCatalogState
): Map<string, number> {
  const wanted = new Map(transfer.blobs.map((blob) => [orcadMigrationBlobIdentity(blob), blob]))
  const offsets = new Map<string, number>()
  for (const upload of state.blobUploads ?? []) {
    const blob = wanted.get(orcadMigrationBlobIdentity(upload))
    // A staged key with other bytes is a different capture; restaging it would mix the two.
    if (!blob || !sameOrcadMigrationBlob(blob, upload)) {
      throw new Error(`orcad_migration_blob_descriptor_conflict:${upload.blobKind}`)
    }
    offsets.set(orcadMigrationBlobIdentity(upload), upload.receivedBytes)
  }
  return offsets
}

function assertAllReceived(transfer: OrcadMigrationBlobTransfer, state: StagedCatalogState): void {
  const received = receivedOffsets(transfer, state)
  for (const blob of transfer.blobs) {
    if (received.get(orcadMigrationBlobIdentity(blob)) !== blob.byteLength) {
      throw new Error(`orcad_migration_blob_transfer_incomplete:${blob.blobKind}`)
    }
  }
}

async function stageChunkWithRecovery(
  transfer: OrcadMigrationBlobTransfer,
  request: OrcadMigrationBlobChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await transfer.destination.stageChunk(request)
    if (result.receivedBytes !== expectedOffset) {
      throw new Error('orcad_migration_blob_ack_invalid')
    }
    return result.receivedBytes
  } catch (error) {
    try {
      const observed = await transfer.destination.readState(transfer.manifest)
      const received =
        observed.state === 'staged'
          ? observed.blobUploads?.find(
              (entry) =>
                orcadMigrationBlobIdentity(entry) === orcadMigrationBlobIdentity(request.blob)
            )?.receivedBytes
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
