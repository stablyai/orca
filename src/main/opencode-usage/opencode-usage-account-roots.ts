import { hasAppEnvironment } from '../../shared/app-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import type { UsageAccountRoot } from '../usage/usage-account-attribution'

export function openCodeUsageAccountRoots(): UsageAccountRoot[] {
  if (!hasAppEnvironment()) {
    return []
  }
  const service = getManagedDataAccountService()
  return service.list('opencode').accounts.map((account) => ({
    accountId: account.id,
    path: resolveOpenCodeDataDirectory(service.environmentForAccount('opencode', account.id))
  }))
}
