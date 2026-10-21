/**
 * The quiesce step's restore hints as the `terminal-restore-hints` migration blob: the bytes, the
 * descriptor the destination checks them against, and the source the blob sender reads from.
 */
import { createHash } from 'node:crypto'
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { sameOrcadMigrationBlob } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES,
  ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
  parseOrcadMigrationTerminalRestoreHintsDocument,
  type OrcadMigrationTerminalRestoreHint
} from '../../../shared/orcad-migration/orcad-migration-terminal-restore-hints'
import type { OrcadMigrationBlobSource } from '../../ssh/orcad-migration-blob-coordinator'

export type WslMoveRestoreHintsBlob = {
  descriptor: OrcadMigrationBlobDescriptor
  bytes: Buffer
  source: OrcadMigrationBlobSource
}

/** Null when there is nothing to carry: the channel sends empty content as no blob at all. */
export function buildWslMoveRestoreHintsBlob(
  hints: readonly OrcadMigrationTerminalRestoreHint[]
): WslMoveRestoreHintsBlob | null {
  if (hints.length === 0) {
    return null
  }
  // Validated here so a bad hint fails the move on this side, before anything is staged.
  const document = parseOrcadMigrationTerminalRestoreHintsDocument({
    version: ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION,
    hints: hints.map((hint) => ({ paneKey: hint.paneKey, cwd: hint.cwd }))
  })
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  if (bytes.length > MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES) {
    throw new Error('orcad_migration_terminal_restore_hints_too_large')
  }
  const descriptor: OrcadMigrationBlobDescriptor = {
    blobKind: 'terminal-restore-hints',
    key: ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
  return {
    descriptor,
    bytes,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        if (!sameOrcadMigrationBlob(requested, descriptor)) {
          throw new Error(`orcad_migration_source_blob_changed:${requested.blobKind}`)
        }
        return bytes.subarray(offset, offset + maxBytes)
      }
    }
  }
}
