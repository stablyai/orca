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
  let running = false
  let pending: { revision: number; usage?: AccountsSnapshot['rateLimits'] } | undefined
  const publish = (usage?: AccountsSnapshot['rateLimits']) => {
    if (!active) {
      return
    }
    pending = { revision: ++revision, usage }
    if (running) {
      return
    }
    running = true
    void (async () => {
      try {
        while (active && pending) {
          const change = pending
          pending = undefined
          try {
            const snapshot = change.usage
              ? {
                  ...snapshots.dataAccounts(),
                  claude: services.claudeAccounts.listAccounts(),
                  codex: await services.codexAccounts.listAccounts(),
                  rateLimits: change.usage
                }
              : await snapshots.stream()
            if (active && revision === change.revision) {
              listener(snapshot)
            }
          } catch (error) {
            console.warn('[accounts] Failed to publish account snapshot', error)
          }
        }
      } finally {
        running = false
      }
    })()
  }
  const unsubscribeData = hasAppEnvironment()
    ? getManagedDataAccountService().onChanged(() => publish())
    : () => {}
  const unsubscribeUsage = services.rateLimits.onStateChange(publish)
  // A rename changes no usage, so without this other clients would show the old name.
  const unsubscribeRenames = [services.claudeAccounts, services.codexAccounts].map((accounts) =>
    accounts.onAccountRenamed(() => publish())
  )
  return () => {
    active = false
    pending = undefined
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
