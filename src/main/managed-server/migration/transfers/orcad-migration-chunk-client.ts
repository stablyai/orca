import { parseOrcadMigrationSnapshotChunkResult } from '../../../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../../../shared/orcad-migration/orcad-migration-scrollback'

import {
  findUnsupportedMigrationBlobKind,
  orcadMigrationBlobKindUnsupportedBlocker,
  parseOrcadMigrationBlobChunkResult
} from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'

import type {
  OrcadMigrationBlobChunkRequest,
  OrcadMigrationBlobChunkResult
} from '../../../../shared/orcad-migration/orcad-migration-blob-transfer'

import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import type { CatalogRequestOptions } from '../catalog/orcad-migration-request'
import { sendSupportedMigrationRequest } from '../catalog/orcad-migration-request'

export async function stageRemoteOrcadMigrationSnapshotChunk(
  pairingCode: string,
  request: OrcadMigrationSnapshotChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
  }
  return parseOrcadMigrationSnapshotChunkResult(response.result, request)
}

export async function stageRemoteOrcadMigrationBlobChunk(
  pairingCode: string,
  request: OrcadMigrationBlobChunkRequest,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationBlobChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(
    pairing,
    'orcad.migration.stageBlobChunk',
    request,
    options,
    false,
    null,
    // Recheck every request so a downgraded destination cannot stage an unsupported blob kind.
    (capabilities) => {
      const unsupported = findUnsupportedMigrationBlobKind([request.blob], capabilities)
      if (unsupported) {
        throw new Error(orcadMigrationBlobKindUnsupportedBlocker(unsupported))
      }
    }
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_blob_failed:${response.error.message}`)
  }
  return parseOrcadMigrationBlobChunkResult(response.result, request)
}
