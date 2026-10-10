import { AI_VAULT_SCOPE_PATHS_MAX_COUNT, type AiVaultListArgs } from '../../shared/ai-vault-types'
import { requestedExecutionHostScope, type ExecutionHostScope } from '../../shared/execution-host'

/** Cache key shared by the desktop IPC list and the runtime RPC, so both reuse one host leg. */
export function aiVaultListCacheKey(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope = requestedExecutionHostScope(args?.executionHostScope)
): string {
  // Canonicalize bounded workspace sets so equivalent scopes share a scan.
  const scopePaths = args?.scopePaths ?? []
  return JSON.stringify({
    scopePaths:
      scopePaths.length <= AI_VAULT_SCOPE_PATHS_MAX_COUNT
        ? [...new Set(scopePaths)].sort()
        : scopePaths,
    executionHostScope,
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true
  })
}
