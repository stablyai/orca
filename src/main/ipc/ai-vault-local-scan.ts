import {
  AiVaultLocalScanError,
  listAiVaultSessions as listCachedLocalAiVaultSessions
} from '../ai-vault/cached-session-list'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'
import { classifyAiVaultScanError } from '../../shared/ai-vault-scan-error-message'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

// Like remote failures, local scanner/cache/WSL failures must degrade to issues without discarding healthy hosts.
export async function scanLocalAiVaultSessionsAsIssue(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await listCachedLocalAiVaultSessions(args, { signal })
  } catch (error) {
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    // Keep raw supervision details in logs; show an actionable host issue.
    const raw = error instanceof Error ? error.message : 'Local session scan failed.'
    console.error('[ai-vault] local session scan failed:', raw)
    const result = aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      ...classifyAiVaultScanError(raw)
    })
    return error instanceof AiVaultLocalScanError ? { ...result, scanId: error.scanId } : result
  }
}
