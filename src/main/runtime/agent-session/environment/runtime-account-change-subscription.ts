import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../../../claude-accounts/selection/runtime-selection'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/agent-accounts/managed-account-types'
import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'

/** Republishes the account stream on usage, data-account and account-name changes. */
export function subscribeRuntimeAccountChanges(
  services: RuntimeAccountServices,
  snapshots: {
    stream: () => Promise<AccountsSnapshot>
    dataAccounts: () => Pick<AccountsSnapshot, 'opencode' | 'devin'>
  },
  listener: (snapshot: AccountsSnapshot) => void
): () => void {
  let active = true
  let revision = 0
  const publish = () => {
    const current = ++revision
    void snapshots
      .stream()
      .then((snapshot) => {
        if (active && revision === current) {
          listener(snapshot)
        }
      })
      .catch((error: unknown) =>
        console.warn('[accounts] Failed to publish account snapshot', error)
      )
  }
  const unsubscribeData = hasAppEnvironment()
    ? getManagedDataAccountService().onChanged(publish)
    : () => {}
  const unsubscribeUsage = services.rateLimits.onStateChange(publish)
  // A rename changes no usage, so without this other clients would show the old name.
  const unsubscribeRenames = [services.claudeAccounts, services.codexAccounts].map((accounts) =>
    accounts.onAccountRenamed(publish)
  )
  return () => {
    active = false
    unsubscribeData()
    unsubscribeUsage()
    unsubscribeRenames.forEach((unsubscribe) => unsubscribe())
  }
}

export function selectedClaudeAccountId(
  state: ClaudeRateLimitAccountsState,
  target: ClaudeAccountSelectionTarget
): string | null {
  return getSelectedClaudeAccountIdForTarget(
    {
      activeClaudeManagedAccountId: state.activeAccountId,
      activeClaudeManagedAccountIdsByRuntime: state.activeAccountIdsByRuntime
    },
    target
  )
}
