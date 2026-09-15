import { FLOATING_TERMINAL_WORKTREE_ID } from '../shared/constants'

/** Floating is the global shell surface; only workspace-owned terminals are scoped. */
export function shouldScopeTerminalHistoryByWorktree(
  settingEnabled: boolean,
  worktreeId: string | undefined
): boolean {
  return Boolean(settingEnabled && worktreeId && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID)
}
