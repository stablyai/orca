import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { resolveClaudeLaunchAccount } from '../claude-accounts/claude-launch-account'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

/**
 * Resolves and validates a create's `--account` before anything is created on disk.
 *
 * Every refusal happens here because the startup terminal is spawned after the checkout exists,
 * and a failure there is only a warning on an otherwise successful create — a worktree whose
 * agent silently never started, or worse, started on the host's active account.
 */
export function resolveWorktreeStartupClaudeAccount(args: {
  request: Pick<
    RuntimeManagedWorktreeCreateArgs,
    'startupClaudeAccount' | 'startupAgent' | 'startup'
  >
  createRouteKind: 'local' | 'ssh' | 'runtime'
  canSpawn: boolean
  listClaudeAccounts: () => ClaudeRateLimitAccountsState
}): string | undefined {
  const selector = args.request.startupClaudeAccount
  if (selector === undefined) {
    return undefined
  }
  if (args.request.startupAgent !== 'claude' || args.request.startup) {
    throw new Error('--account requires --agent claude.')
  }
  if (args.createRouteKind !== 'local') {
    throw new Error(
      'Claude --account launches run on this Orca host only; they are not supported for SSH or connected-server workspaces.'
    )
  }
  if (!args.canSpawn) {
    // Why: without a runtime PTY lane the renderer would launch the agent on the active account.
    throw new Error('This Orca runtime cannot start Claude --account terminals.')
  }
  return resolveClaudeLaunchAccount(args.listClaudeAccounts(), selector).accountId
}
