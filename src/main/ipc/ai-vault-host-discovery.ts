import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'

export type AiVaultHostDiscoveryResult<T> = {
  hostInfos: readonly T[]
  issue?: AiVaultListResult
}

/** Degrade throwing host enumeration to an issue so all-hosts reads retain healthy local sessions. */
export function discoverAiVaultHosts<T>(
  enumerate: () => readonly T[],
  args: { path: string; fallbackMessage: string }
): AiVaultHostDiscoveryResult<T> {
  try {
    return { hostInfos: enumerate() }
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
