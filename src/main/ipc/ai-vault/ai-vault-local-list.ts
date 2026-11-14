import { forwardRowInterest } from '../../ai-vault/scan-lifecycle/ai-vault-row-interest'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import {
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  AiVaultLocalScanError
} from '../../ai-vault/listing/cached-session-list'
import { aiVaultScanIssueResult } from '../../ai-vault/listing/session-list-results'
import { classifyAiVaultScanError } from '../../../shared/ai-vault/scanning/ai-vault-scan-error-message'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
// Like remote failures, local scanner/cache/WSL failures must degrade to issues without discarding healthy hosts.
export async function scanLocalAiVaultSessionsAsIssue(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined,
  publish?: (delta: AiVaultRowDelta) => void
): Promise<AiVaultListResult> {
  try {
    const observe = publish
      ? (rows: AiVaultScanRows) =>
          publish(rows.kind === 'delta' ? rows.delta : { upserts: [...rows.sessions], removed: [] })
      : undefined
    if (observe && publish) {
      forwardRowInterest(observe, publish)
    }
    return await listCachedLocalAiVaultSessions(args, { signal, observeRows: observe })
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
