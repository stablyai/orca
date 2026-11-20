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
  let pending:
    | {
        revision: number
        generations: readonly [number, number]
        usage?: AccountsSnapshot['rateLimits']
      }
    | undefined
  const publish = (usage?: AccountsSnapshot['rateLimits']) => {
    if (!active) {
      return
    }
    // Usage-only updates must not invalidate a completed roster read.
    if (!usage) {
      revision++
    }
    pending = { revision, generations: services.rateLimits.getAccountRefreshGenerations(), usage }
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
            const currentGenerations = services.rateLimits.getAccountRefreshGenerations()
            if (
              active &&
              revision === change.revision &&
              change.generations.every(
                (generation, index) => generation === currentGenerations[index]
              )
            ) {
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
