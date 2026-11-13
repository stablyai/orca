import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault/scanning/ai-vault-scope-paths'
import {
  boundedAiVaultScopeArgs,
  type AiVaultListArgs,
  type AiVaultScope
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
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

/** The scope sent to the host: capped because older hosts reject oversized scopePaths; All keeps the recency scan. */
export function mobileAiVaultScanScopeArgs(
  scope: AiVaultScope,
  scopePaths: readonly string[]
): Pick<AiVaultListArgs, 'scopePaths' | 'scopeOnly'> {
  return boundedAiVaultScopeArgs(scopePaths, scope !== 'all')
}

function toScopePathWorktree(worktree: ScopeWorktree) {
  return {
    id: worktree.worktreeId,
    path: worktree.path,
    repoId: worktree.repoId,
    priorWorktreeIds: worktree.priorWorktreeIds
  }
}
