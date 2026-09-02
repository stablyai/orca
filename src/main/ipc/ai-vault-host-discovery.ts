import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'

export type AiVaultHostDiscoveryResult<T> = {
  hostInfos: readonly T[]
  issue?: AiVaultListResult
}

/**
 * Why: enumerating runtime/SSH hosts reads live session state and can throw. In
 * 'all' scope that rejection would take down the whole Promise.all and drop the
 * local sessions too, so a broken enumerator degrades to one issue row instead.
 */
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
