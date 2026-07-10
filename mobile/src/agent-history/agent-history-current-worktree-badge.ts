import type { AiVaultScope } from '../../../src/shared/ai-vault-types'

export function shouldShowMobileCurrentWorktreeBadge(scope: AiVaultScope): boolean {
  // Why: Workspace is already the current-worktree-only view; Project and All
  // still mix in sibling/other worktrees, so the badge remains useful there.
  return scope !== 'workspace'
}
