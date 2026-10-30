import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault-scope-paths'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

export const MOBILE_AGENT_HISTORY_SCOPE_TABS: { scope: AiVaultScope; label: string }[] = [
  { scope: 'workspace', label: 'Workspace' },
  { scope: 'project', label: 'Project' },
  { scope: 'all', label: 'All' }
]

type ScopeWorktree = Pick<Worktree, 'worktreeId' | 'path' | 'repoId' | 'priorWorktreeIds'>

// Desktop's scope paths from worktree.ps rows; with no project metadata on the phone, Project is the active repo.
// scopePaths only widen the host scan's discovery breadth; they are host-local match prefixes, never device paths.
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: ScopeWorktree | null,
  liveWorktrees: readonly ScopeWorktree[]
): string[] {
  if (!activeWorktree) {
    return []
  }
  return deriveAiVaultScopeSessionPaths(
    toScopePathWorktree(activeWorktree),
    liveWorktrees.map(toScopePathWorktree),
    { scope }
  )
}

/** The scan hints sent to the host; older hosts reject oversized scopePaths, and hints only widen discovery. */
export function mobileAiVaultScanScopePaths(scopePaths: readonly string[]): string[] {
  return scopePaths.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
}

function toScopePathWorktree(worktree: ScopeWorktree) {
  return {
    id: worktree.worktreeId,
    path: worktree.path,
    repoId: worktree.repoId,
    priorWorktreeIds: worktree.priorWorktreeIds
  }
}
