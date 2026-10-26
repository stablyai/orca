import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault-scope-paths'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

type ScopeWorktree = Pick<Worktree, 'worktreeId' | 'path' | 'repoId' | 'priorWorktreeIds'>

/** Desktop's scope paths from worktree.ps rows; with no project metadata on the phone, Project is the active repo. */
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
      { scope }
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
