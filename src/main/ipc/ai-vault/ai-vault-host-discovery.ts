import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { aiVaultScanIssueResult } from '../../ai-vault/listing/session-list-results'

export type AiVaultHostDiscoveryResult<T> = {
  hostInfos: readonly T[]
  issue?: AiVaultListResult
}

/** Degrade throwing host enumeration to an issue so all-hosts reads retain healthy local sessions. */
export async function discoverAiVaultHosts<T>(
  enumerate: () => readonly T[] | Promise<readonly T[]>,
  args: { path: string; fallbackMessage: string }
): Promise<AiVaultHostDiscoveryResult<T>> {
  try {
    return { hostInfos: await enumerate() }
  } catch (error) {
    return {
      hostInfos: [],
      issue: aiVaultScanIssueResult({
        path: args.path,
        message: error instanceof Error ? error.message : args.fallbackMessage
      })
    }
  }
}
