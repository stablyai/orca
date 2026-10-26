import { toAiVaultProjectKey } from '../../../src/shared/ai-vault-project-key'
import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault-scope-paths'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

type ScopeWorktree = Pick<Worktree, 'worktreeId' | 'path' | 'repoId' | 'priorWorktreeIds'>

/** Desktop's scope paths from worktree.ps rows; the phone has no project metadata, so the project is the repo. */
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: ScopeWorktree | null,
  liveWorktrees: readonly ScopeWorktree[]
): string[] {
  if (!activeWorktree) {
    return []
  }
  return (
    deriveAiVaultScopeSessionPaths(
      toScopePathWorktree(activeWorktree),
      liveWorktrees.map(toScopePathWorktree),
      { scope, activeProjectKey: toAiVaultProjectKey(null, activeWorktree.repoId) }
    )
      // Older hosts reject oversized scopePaths; hints only widen discovery, so drop the tail.
      .slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  )
}

function toScopePathWorktree(worktree: ScopeWorktree) {
  return {
    id: worktree.worktreeId,
    path: worktree.path,
    repoId: worktree.repoId,
    priorWorktreeIds: worktree.priorWorktreeIds
  }
}
