import { listAiVaultSessions as listCachedLocalAiVaultSessions } from '../ai-vault/cached-session-list'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'
import { describeAiVaultScanError } from '../../shared/ai-vault-scan-error-message'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

// Why: the SSH legs already degrade to an issue row so one bad host can't take
// the shared Promise.all down; the local leg can throw too (parse-cache load,
// WSL home resolution, scanner service supervision) and would otherwise discard
// every host's sessions under 'all', or replace the list with a raw error string
// under single-host scope.
export async function scanLocalAiVaultSessionsAsIssue(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await scanLocalAiVaultSessions(args, signal)
  } catch (error) {
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    // Raw supervision text ("restart circuit is open") means nothing to a user,
    // so the row carries actionable copy and the log keeps the original.
    const raw = error instanceof Error ? error.message : 'Local session scan failed.'
    console.error('[ai-vault] local session scan failed:', raw)
    return aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      message: describeAiVaultScanError(raw)
    })
  }
}

async function scanLocalAiVaultSessions(
  args?: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  // Why: the shared cache module owns codex-home/WSL sourcing and the local
  // scan cache, so the desktop IPC path and the runtime RPC method (mobile)
  // share one cache instance and one source of managed-Codex homes.
  return listCachedLocalAiVaultSessions(
    {
      limit: args?.limit,
      unlimited: args?.unlimited,
      force: args?.force,
      scopePaths: args?.scopePaths
    },
    { signal }
  )
}
