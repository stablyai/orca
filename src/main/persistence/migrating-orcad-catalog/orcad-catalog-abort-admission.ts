import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../../../shared/pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS } from '../../../shared/pty-ownership-transfer-destination-adapter'
import {
  parsePtyOwnershipTransferDestinationFile,
  readPtyOwnershipTransferDestinationFile,
  type PtyOwnershipTransferDestinationFileRecord
} from '../pty-ownership-transfer/pty-ownership-transfer-destination-file'
import { ptyOwnershipTransferDestinationDirectory } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'

/** Fresh synchronous evidence immediately before removing a stage; never infer source exit. */
export function assertOrcadMigrationCatalogAbortSafe(
  manifest: OrcadMigrationManifest,
  profileDirectory: string
): void {
  const directory = ptyOwnershipTransferDestinationDirectory(profileDirectory)
  let files: string[]
  try {
    files = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw new Error('orcad_migration_catalog_abort_unverifiable', { cause: error })
  }
  if (files.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw new Error('orcad_migration_catalog_abort_unverifiable')
  }
  for (const file of files) {
    let record: PtyOwnershipTransferDestinationFileRecord
    try {
      record = parsePtyOwnershipTransferDestinationFile(
        readPtyOwnershipTransferDestinationFile(join(directory, file)),
        PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
      )
      if (`${createHash('sha256').update(record.journal.bridgeId).digest('hex')}.json` !== file) {
        throw new Error('pty_ownership_transfer_destination_store_filename_invalid')
      }
    } catch (error) {
      throw new Error('orcad_migration_catalog_abort_unverifiable', { cause: error })
    }
    const admitted = record.catalogAdmission?.manifest
    if (admitted?.migrationId !== manifest.migrationId) {
      continue
    }
    if (admitted.manifestSha256 !== manifest.manifestSha256) {
      throw new Error('orcad_migration_catalog_abort_manifest_conflict')
    }
    if (record.journal.phase !== 'aborted') {
      throw new Error('orcad_migration_catalog_abort_transfer_active')
    }
  }
}
