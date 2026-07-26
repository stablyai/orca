import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { mergeAiVaultListResults } from '../ai-vault/session-list-results'

export const AI_VAULT_ALL_HOST_SCAN_CONCURRENCY = 4

export async function scanAiVaultHostsInBatches(
  scans: readonly (() => Promise<AiVaultListResult>)[],
  initialResults: readonly AiVaultListResult[],
  limit: number | undefined
): Promise<AiVaultListResult> {
  let merged = mergeAiVaultListResults(initialResults, limit)
  for (let offset = 0; offset < scans.length; offset += AI_VAULT_ALL_HOST_SCAN_CONCURRENCY) {
    const batch = scans.slice(offset, offset + AI_VAULT_ALL_HOST_SCAN_CONCURRENCY)
    merged = mergeAiVaultListResults(
      [merged, ...(await Promise.all(batch.map((scan) => scan())))],
      limit
    )
  }
  return merged
}
