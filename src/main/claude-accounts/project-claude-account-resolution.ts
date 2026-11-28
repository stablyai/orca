import type { Repo } from '../../shared/repository/repo-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  ACTIVE_CLAUDE_ACCOUNT,
  isPinnableClaudeAccountId
} from '../../shared/claude/project-claude-account-preference'

export function resolveProjectClaudeAccount(input: {
  getRepo: (repoId: string) => Repo | undefined
  worktreeId?: string
  repoId?: string
  launchConfigAccountId?: string
  explicitAccountId?: string
  /** The terminal's account target; absent means the host. */
  target?: { runtime?: 'host' | 'wsl' }
}): string | undefined {
  if (input.explicitAccountId === ACTIVE_CLAUDE_ACCOUNT) {
    return undefined
  }
  if (isPinnableClaudeAccountId(input.explicitAccountId)) {
    return input.explicitAccountId
  }
  // Why: pinned launches are host-only, so a WSL terminal ignores recorded and saved defaults
  // and launches unpinned instead of refusing; an explicit `--account` still refuses there.
  if (input.target?.runtime === 'wsl') {
    return undefined
  }
  // Why: a launch config records the launch's own choice (incl. "active this time"); it outranks the project default on resume.
  if (input.launchConfigAccountId === ACTIVE_CLAUDE_ACCOUNT) {
    return undefined
  }
  if (isPinnableClaudeAccountId(input.launchConfigAccountId)) {
    return input.launchConfigAccountId
  }
  const repoId =
    input.repoId ?? (input.worktreeId ? getRepoIdFromWorktreeId(input.worktreeId) : undefined)
  const preference = repoId ? input.getRepo(repoId)?.agentAccounts?.claude : undefined
  return preference?.mode === 'account' ? preference.accountId : undefined
}
