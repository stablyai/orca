import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault/scanning/ai-vault-scope-paths'
import { toAiVaultProjectKey } from '../../../src/shared/ai-vault/scanning/ai-vault-project-key'
import {
  boundedAiVaultScopeArgs,
  type AiVaultListArgs,
  type AiVaultScope
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { ProjectHostSetup } from '../../../src/shared/project/project-types'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'

export const MOBILE_AGENT_HISTORY_SCOPE_TABS: { scope: AiVaultScope; label: string }[] = [
  { scope: 'workspace', label: 'Workspace' },
  { scope: 'project', label: 'Project' },
  { scope: 'all', label: 'All' }
]

type ScopeWorktree = Pick<Worktree, 'worktreeId' | 'path' | 'repoId' | 'priorWorktreeIds'>

/** The host's project setups a Project scope reads; empty on hosts that don't list them. */
export type MobileAiVaultProjectSetup = Pick<ProjectHostSetup, 'projectId' | 'repoId' | 'path'>

/** Desktop's scope paths from worktree.ps rows; Project spans every repo the host files under the active repo's project. */
// scopePaths only widen the host scan's discovery breadth; they are host-local match prefixes, never device paths.
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: ScopeWorktree | null,
  liveWorktrees: readonly ScopeWorktree[],
  projectSetups: readonly MobileAiVaultProjectSetup[] = []
): string[] {
  if (!activeWorktree) {
    return []
  }
  // Desktop's resolveActiveProjectKey: the repo's setup names its project, else the repo is its own.
  const setup = projectSetups.find((candidate) => candidate.repoId === activeWorktree.repoId)
  return deriveAiVaultScopeSessionPaths(
    toScopePathWorktree(activeWorktree),
    liveWorktrees.map(toScopePathWorktree),
    {
      scope,
      activeProjectKey: toAiVaultProjectKey(setup?.projectId, activeWorktree.repoId),
      projectHostSetupProjection: { setups: projectSetups }
    }
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
