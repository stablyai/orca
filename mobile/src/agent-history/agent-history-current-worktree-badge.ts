import type { AiVaultScope } from '../../../src/shared/ai-vault-types'

export function shouldShowMobileCurrentWorktreeBadge(scope: AiVaultScope): boolean {
  // Only Project/All mix sibling worktrees; Workspace already means current worktree.
  return scope !== 'workspace'
}
