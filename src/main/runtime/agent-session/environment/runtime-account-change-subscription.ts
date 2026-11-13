import { hasAppEnvironment } from '../../../../shared/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'

/** Republishes the account stream on usage, data-account and account-name changes. */
export function subscribeRuntimeAccountChanges(
  services: RuntimeAccountServices,
  snapshots: {
    stream: () => AccountsSnapshot
    dataAccounts: () => Pick<AccountsSnapshot, 'opencode' | 'devin'>
  },
  listener: (snapshot: AccountsSnapshot) => void
): () => void {
  const unsubscribeData = hasAppEnvironment()
    ? getManagedDataAccountService().onChanged(() => listener(snapshots.stream()))
    : () => {}
  const unsubscribeUsage = services.rateLimits.onStateChange((rateLimits) => {
    listener({
      ...snapshots.dataAccounts(),
      claude: services.claudeAccounts.listAccounts(),
      codex: services.codexAccounts.listAccounts(),
      rateLimits
    })
  })
  // A rename changes no usage, so without this other clients would show the old name.
  const unsubscribeRenames = [services.claudeAccounts, services.codexAccounts].map((accounts) =>
    accounts.onAccountRenamed(() => listener(snapshots.stream()))
  )
  return () => {
    unsubscribeData()
    unsubscribeUsage()
    unsubscribeRenames.forEach((unsubscribe) => unsubscribe())
  }
}
