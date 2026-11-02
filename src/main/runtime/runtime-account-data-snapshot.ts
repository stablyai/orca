import { hasAppEnvironment } from '../../shared/app-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import type { AccountsSnapshot } from './runtime-account-controller'

type DataAccountsSnapshot = Pick<AccountsSnapshot, 'opencode' | 'devin'>

/** A stream snapshot keeps one provider's committed change even when another provider is unavailable. */
export function streamDataAccountsSnapshot(): DataAccountsSnapshot {
  const snapshot: DataAccountsSnapshot = {}
  if (hasAppEnvironment()) {
    const service = getManagedDataAccountService()
    for (const provider of ['opencode', 'devin'] as const) {
      try {
        snapshot[provider] = service.list(provider)
      } catch {
        // Optional unavailable evidence must not swallow another provider's committed change.
      }
    }
  }
  return snapshot
}

export function dataAccountsSnapshot(): DataAccountsSnapshot {
  if (!hasAppEnvironment()) {
    return {}
  }
  const service = getManagedDataAccountService()
  return { opencode: service.list('opencode'), devin: service.list('devin') }
}
