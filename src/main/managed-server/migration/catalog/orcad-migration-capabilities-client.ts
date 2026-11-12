import { z } from 'zod'
import { listServerRows } from './orcad-server-catalog-rows'
import type { CatalogRequestOptions } from './orcad-migration-request'

/** The destination host's runtime capabilities, read before a migration transfers its blobs. */
export async function readRemoteOrcadMigrationCapabilities(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<readonly string[]> {
  const status = await listServerRows(pairingCode, 'status.get', 'status', options)
  return z.object({ capabilities: z.array(z.string()).default([]) }).parse(status).capabilities
}
