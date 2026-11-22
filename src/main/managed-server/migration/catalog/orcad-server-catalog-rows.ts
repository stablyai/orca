import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import type { CatalogRequestOptions } from './orcad-migration-request'
import { sendSupportedMigrationRequest } from './orcad-migration-request'

export async function listServerRows(
  pairingCode: string,
  method: string,
  rows: string,
  options: CatalogRequestOptions
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendSupportedMigrationRequest(pairing, method, undefined, options)
  if (!response.ok) {
    throw new Error(`orcad_migration_${rows}_failed:${response.error.message}`)
  }
  return response.result
}
