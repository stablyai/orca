import { getAiVaultSessionSourcesCacheKey } from '../ai-vault/cached-session-list'
import { AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostScope } from '../../shared/execution-host'

export type AiVaultListCacheKeys = {
  /** Coalescing + whole-result key; carries the local Codex source identity. */
  key: string
  /** Per-host leg key; deliberately source-free. */
  remoteLegKey: string
}

/**
 * Builds the two cache keys an Agent History list request needs.
 *
 * They differ on purpose: a per-host leg holds only that host's sessions, so a
 * local Codex-home change must not evict it — an all-hosts view would otherwise
 * re-pay every SSH host's multi-second walk for a change no remote result can
 * depend on. The local/all key does carry the source identity, because those
 * results contain local sessions and would go stale without it.
 */
export function buildAiVaultListCacheKeys(args: {
  scopePaths: readonly string[]
  executionHostScope: ExecutionHostScope
}): AiVaultListCacheKeys {
  // A scanner consumes at most 64 paths, so smaller equivalent workspace sets
  // can share a snapshot regardless of which worktree was selected first.
  const scopeKey = {
    scopePaths:
      args.scopePaths.length <= AI_VAULT_SCOPE_PATHS_MAX_COUNT
        ? [...new Set(args.scopePaths)].sort()
        : args.scopePaths,
    executionHostScope: args.executionHostScope
  }
  const scansLocally =
    args.executionHostScope === LOCAL_EXECUTION_HOST_ID || args.executionHostScope === 'all'
  return {
    key: JSON.stringify({
      ...scopeKey,
      localSessionSources: scansLocally ? getAiVaultSessionSourcesCacheKey() : null
    }),
    remoteLegKey: JSON.stringify(scopeKey)
  }
}
