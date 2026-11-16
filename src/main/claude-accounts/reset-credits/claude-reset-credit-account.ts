import type { ClaudeResetAccount } from '../../../shared/agent-accounts/claude/claude-reset-credit-types'
import type { ClaudeRateLimitAccountsState } from '../../../shared/agent-accounts/managed-account-types'
import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../profiles/routing/claude-profile-installed-router'
import { getSelectedClaudeAccountIdForTarget } from '../selection/runtime-selection'
import { isWslDistroRunning } from '../../wsl/discovery/wsl-background-distro-gate'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'

export async function prepareClaudeResetAccount(
  account: ClaudeResetAccount,
  state: ClaudeRateLimitAccountsState
): Promise<{ auth: ClaudeRuntimeAuthPreparation; email: string | null }> {
  const { target, accountId } = account
  const distro = target.runtime === 'wsl' ? target.wslDistro : null
  const selected = getSelectedClaudeAccountIdForTarget(
    {
      activeClaudeManagedAccountId: state.activeAccountId,
      activeClaudeManagedAccountIdsByRuntime: state.activeAccountIdsByRuntime
    },
    target
  )
  if (selected !== accountId) {
    throw new Error('The selected Claude account changed. Reopen the usage menu.')
  }
  const saved =
    accountId === null ? null : state.accounts.find((candidate) => candidate.id === accountId)
  if (accountId !== null && (!saved || saved.needsSignIn)) {
    throw new Error('Sign in to this Claude account before using reset cards.')
  }
  let auth: ClaudeRuntimeAuthPreparation | undefined
  if (target.runtime === 'wsl') {
    if (!distro || !(await isWslDistroRunning(distro))) {
      throw new Error('Start this WSL distro before querying Claude reset cards.')
    }
    auth = await getClaudeWslProfileRouter()?.preparation(distro)
  } else {
    auth = getClaudeProfileRouter()?.preparation()
  }
  if (!auth || auth.usageError) {
    throw new Error(auth?.usageError ?? 'Claude account routing is unavailable on this host.')
  }
  return {
    auth,
    email: saved?.email ?? (target.runtime === 'host' ? (state.systemDefaultEmail ?? null) : null)
  }
}
