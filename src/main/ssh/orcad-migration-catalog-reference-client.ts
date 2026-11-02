import { parseOrcadMigrationCatalogReferenceAbortResult } from '../../shared/orcad-migration/orcad-migration-catalog-state'
import type {
  OrcadMigrationCatalogReference,
  OrcadMigrationCatalogReferenceAbortResult
} from '../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  ORCAD_MIGRATION_DESTINATION_UNSUPPORTED,
  sendSupportedMigrationRequest,
  type CatalogRequestOptions
} from './orcad-migration-catalog-client'

/** Unlike migration-unsupported, this refusal cannot prove no earlier stage exists. */
export const ORCAD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED =
  'orcad_migration_destination_abort_by_reference_unsupported:Update Orca on this host to cancel this move.'

/** Abort by manifest identity when the full request cannot fit the sealed frame. */
export async function abortRemoteOrcadMigrationCatalogByReference(
  pairingCode: string,
  manifest: OrcadMigrationCatalogReference,
  options: CatalogRequestOptions = {}
): Promise<OrcadMigrationCatalogReferenceAbortResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  let supportsReference = false
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await sendSupportedMigrationRequest(
      pairing,
      'orcad.migration.abortCatalogByReference',
      { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      options,
      false,
      null,
      (capabilities) => {
        supportsReference = capabilities.includes(
          ORCAD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY
        )
        if (!supportsReference) {
          throw new Error(ORCAD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
        }
      }
    )
  } catch (error) {
    // A missing method on a host that advertised it proves nothing about what it staged.
    if (
      supportsReference &&
      error instanceof Error &&
      error.message === ORCAD_MIGRATION_DESTINATION_UNSUPPORTED
    ) {
      throw new Error(ORCAD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
    }
    throw error
  }
  if (!response.ok) {
    throw new Error(`orcad_migration_abort_failed:${response.error.message}`)
  }
  return parseOrcadMigrationCatalogReferenceAbortResult(response.result, manifest)
}
