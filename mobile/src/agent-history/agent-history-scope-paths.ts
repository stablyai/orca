import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault-types'

// Derive locally because Metro cannot resolve renderer helpers; seed active/same-repo paths from worktree.ps.
// scopePaths widen host discovery only; they are host-local prefixes, never device paths.
export function deriveMobileAiVaultScopePaths(
  scope: AiVaultScope,
  activeWorktree: Pick<Worktree, 'worktreeId' | 'path' | 'repoId'> | null,
  liveWorktrees: readonly Pick<Worktree, 'worktreeId' | 'path' | 'repoId'>[]
): string[] {
  // All scope omits hints to retain host’s global recency list.
  if (scope === 'all' || !activeWorktree) {
    return []
  }

  const paths: string[] = []
  const comparisonPaths = new Set<string>()
  addScopePath(paths, comparisonPaths, activeWorktree.path)

  // Workspace uses active path; Project includes same-repo siblings.
  if (scope === 'project') {
    for (const worktree of liveWorktrees) {
      // RPC rejects oversized scopePaths; drop tail hints rather than fail scan because hints only widen discovery.
      if (paths.length >= AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
        break
      }
      if (worktree.repoId === activeWorktree.repoId) {
        addScopePath(paths, comparisonPaths, worktree.path)
      }
    }
  }

  return paths
}

function addScopePath(
  paths: string[],
  comparisonPaths: Set<string>,
  pathValue: string | undefined
): void {
  const trimmedPath = pathValue?.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  if (comparisonPaths.has(comparisonPath)) {
    return
  }
  comparisonPaths.add(comparisonPath)
  paths.push(trimmedPath)
}
