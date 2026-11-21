import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'

export async function readRuntimeAccountsSnapshot(
  services: RuntimeAccountServices,
  dataAccounts: () => Pick<AccountsSnapshot, 'opencode' | 'devin'>
): Promise<AccountsSnapshot> {
  const { claudeAccounts, codexAccounts, rateLimits } = services
  let revision = 0
  const changed = (): void => {
    revision++
  }
  const unsubscribers = [claudeAccounts, codexAccounts].map((accounts) =>
    accounts.onAccountRenamed(changed)
  )
  if (hasAppEnvironment()) {
    unsubscribers.push(getManagedDataAccountService().onChanged(changed))
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const beforeRevision = revision
      const generations = rateLimits.getAccountRefreshGenerations()
      const snapshot = {
        ...dataAccounts(),
        claude: claudeAccounts.listAccounts(),
        codex: await codexAccounts.listAccounts(),
        rateLimits: await rateLimits.getState()
      }
      const currentGenerations = rateLimits.getAccountRefreshGenerations()
      if (
        beforeRevision === revision &&
        generations.every((generation, index) => generation === currentGenerations[index])
      ) {
        return snapshot
      }
    }
    throw new Error('Accounts changed while reading the snapshot. Try again.')
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe())
  }
}
