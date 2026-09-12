import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../../../shared/pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS } from '../../../shared/pty-ownership-transfer-destination-adapter'
import {
  parsePtyOwnershipTransferDestinationFile,
  readPtyOwnershipTransferDestinationFile
} from '../pty-ownership-transfer/pty-ownership-transfer-destination-file'
import { ptyOwnershipTransferDestinationDirectory } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'
import { inspectPtyOwnershipTransferCatalogSurface } from '../loading-store/pty-ownership-transfer-catalog-surface-admission'
import type { ReservedPtyOwnershipTransferLayout } from '../loading-store/pty-ownership-transfer-reserved-layout-admission'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { projectOrcadLiveSessionForCatalog } from './orcad-live-session-projection'

export function resolveOrcadCatalogLiveProjection(
  manifest: OrcadMigrationManifest,
  runtime: Pick<StoreRuntimeState, 'dataFile' | 'state' | 'terminalScrollbackSnapshotStorage'>,
  allowPartialOwner: boolean
) {
  const incoming = manifest.payload.dormantState?.workspaceSession
  if (!incoming) {
    return null
  }
  const directory = ptyOwnershipTransferDestinationDirectory(dirname(runtime.dataFile))
  let files: string[]
  try {
    files = readdirSync(directory).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (files.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw new Error('orcad_migration_live_projection_unverifiable')
  }
  const reservations = new Map<string, ReservedPtyOwnershipTransferLayout>()
  for (const file of files) {
    const record = parsePtyOwnershipTransferDestinationFile(
      readPtyOwnershipTransferDestinationFile(join(directory, file)),
      PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
    )
    if (`${createHash('sha256').update(record.journal.bridgeId).digest('hex')}.json` !== file) {
      throw new Error('orcad_migration_live_projection_filename_invalid')
    }
    const admitted = record.catalogAdmission?.manifest
    if (admitted?.migrationId !== manifest.migrationId) {
      continue
    }
    if (admitted.manifestSha256 !== manifest.manifestSha256) {
      throw new Error('orcad_migration_live_projection_manifest_conflict')
    }
    if (!record.publicationIntent || !record.surfaceBinding) {
      continue
    }
    const inspected = inspectPtyOwnershipTransferCatalogSurface(
      runtime,
      runtime.state.workspaceSession,
      {
        identity: record.journal,
        surfaceBinding: record.surfaceBinding,
        publicationReceipt: record.publicationIntent
      }
    )
    if (inspected) {
      reservations.set(inspected.reservation.tab.id, inspected.reservation)
    }
  }
  if (reservations.size === 0) {
    return null
  }
  return projectOrcadLiveSessionForCatalog(
    runtime.state.workspaceSession,
    incoming,
    [...reservations.values()],
    { allowPartialOwner }
  )
}
