import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
export function claudeAccountRequiresPrivateHistory(
  settings: Pick<GlobalSettings, 'claudeManagedAccounts' | 'claudeWorkspaceAccounts'>,
  accountId: string
): boolean {
  return (
    settings.claudeManagedAccounts.some(
      (account) => account.id === accountId && account.privateHistory
    ) || Object.values(settings.claudeWorkspaceAccounts ?? {}).includes(accountId)
  )
}
