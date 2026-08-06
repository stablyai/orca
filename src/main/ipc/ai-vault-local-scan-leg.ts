import { listAiVaultSessions as listCachedLocalAiVaultSessions } from '../ai-vault/cached-session-list'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { shouldForceAiVaultHost } from './ai-vault-refresh-policy'

// Why: the SSH legs already degrade to an issue row so one bad host can't take
// the shared Promise.all down; the local leg can throw too (parse-cache load,
// WSL home resolution) and would otherwise discard every host's sessions.
export async function scanLocalAiVaultSessionsForAllScope(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await scanLocalAiVaultSessions(args, signal)
  } catch (error) {
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    return aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      message: error instanceof Error ? error.message : 'Local session scan failed.'
    })
  }
}

export async function scanLocalAiVaultSessions(
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
      force: shouldForceAiVaultHost(args, LOCAL_EXECUTION_HOST_ID),
      scopePaths: args?.scopePaths
    },
    { signal }
  )
}
