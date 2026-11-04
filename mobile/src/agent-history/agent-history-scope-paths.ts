import { deriveAiVaultScopeSessionPaths } from '../../../src/shared/ai-vault/scanning/ai-vault-scope-paths'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultScope
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { splitWorktreeIdForFilesystem } from '../../../src/shared/worktree/id'
import type { Worktree } from '../worktree/workspace-list-types'

type ScopeWorktree = Pick<Worktree, 'worktreeId' | 'path' | 'repoId' | 'priorWorktreeIds'>

/** Resolves the active worktree from catalog rows, falling back to the repoId::path encoded in worktreeId before worktree.ps settles. */
export function resolveActiveHistoryWorktree(
  worktrees: readonly Worktree[],
  worktreeId: string,
  fastFirstScreen = false
): Worktree | null {
  const matched = worktrees.find((worktree) => worktree.worktreeId === worktreeId)
  if (matched) {
    return matched
  }
  if (!fastFirstScreen) {
    return null
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed?.repoId && parsed.worktreePath
    ? {
        worktreeId,
        repoId: parsed.repoId,
        path: parsed.worktreePath,
        repo: '',
        branch: '',
        displayName: '',
        liveTerminalCount: 0
      }
    : null
}

/** Desktop's scope paths from worktree.ps rows; with no project metadata on the phone, Project is the active repo. */
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

/** Stable scan identity for one scope. A new worktree array with the same paths keeps this key. */
export function mobileAiVaultScopePathsKey(
  scope: AiVaultScope,
  activeWorktree: ScopeWorktree | null,
  liveWorktrees: readonly ScopeWorktree[]
): string {
  return mobileAiVaultScanScopePaths(
    deriveMobileAiVaultScopePaths(scope, activeWorktree, liveWorktrees)
  ).join('\0')
}

function toScopePathWorktree(worktree: ScopeWorktree) {
  return {
    id: worktree.worktreeId,
    path: worktree.path,
    repoId: worktree.repoId,
    priorWorktreeIds: worktree.priorWorktreeIds
  }
}
