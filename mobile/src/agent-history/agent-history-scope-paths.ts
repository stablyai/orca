import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault-types'

// Why: the renderer's deriveAiVault* helpers are renderer-located and
// Metro-unresolvable, so mobile does its own minimal derivation seeded by the
// active worktree's path plus same-repo sibling worktrees (mobile already loads
// the full worktree list via worktree.ps). scopePaths only widen the host scan's
// discovery breadth; they are host-local match prefixes, never device paths.
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: Pick<Worktree, 'worktreeId' | 'path' | 'repoId'> | null,
  liveWorktrees: readonly Pick<Worktree, 'worktreeId' | 'path' | 'repoId'>[]
): string[] {
  // 'all' scope scans without scope hints — the host returns the global recency
  // list, so no scopePaths are needed (and would only narrow discovery).
  if (scope === 'all' || !activeWorktree) {
    return []
  }

  const paths: string[] = []
  addScopePath(paths, activeWorktree.path)

  // Workspace scope = the active worktree only. Project scope additionally
  // covers same-repo sibling worktrees so the project view stays complete.
  if (scope === 'project') {
    for (const worktree of liveWorktrees) {
      // Why: the RPC rejects (does not truncate) oversized scopePaths, and the
      // list only widens discovery — dropping tail siblings beats hard-failing.
      if (paths.length >= AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
        break
      }
      if (worktree.repoId === activeWorktree.repoId) {
        addScopePath(paths, worktree.path)
      }
    }
  }

  return paths
}

function addScopePath(paths: string[], pathValue: string | undefined): void {
  const trimmedPath = pathValue?.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  if (
    paths.some((existingPath) => normalizeRuntimePathForComparison(existingPath) === comparisonPath)
  ) {
    return
  }
  paths.push(trimmedPath)
}
