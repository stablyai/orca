import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  assignWorkspaceAccount,
  type WorkspaceAccountAssignment
} from '../../../../shared/agent-accounts/workspace-account-binding'

export function workspaceAccountSettingUpdates(
  settings: Partial<
    Pick<
      GlobalSettings,
      | 'claudeWorkspaceAccounts'
      | 'codexWorkspaceAccounts'
      | 'claudeManagedAccounts'
      | 'codexManagedAccounts'
    >
  >,
  updates: {
    claudeWorkspaceAccount?: WorkspaceAccountAssignment
    codexWorkspaceAccount?: WorkspaceAccountAssignment
  }
): Partial<GlobalSettings> {
  const result: Partial<GlobalSettings> = {}
  const claude = updates.claudeWorkspaceAccount
  const codex = updates.codexWorkspaceAccount
  if (claude) {
    result.claudeWorkspaceAccounts = assignWorkspaceAccount(
      settings.claudeWorkspaceAccounts,
      settings.claudeManagedAccounts,
      claude,
      'Claude'
    )
    if (claude.accountId) {
      result.claudeManagedAccounts = (settings.claudeManagedAccounts ?? []).map((account) =>
        account.id === claude.accountId ? { ...account, privateHistory: true } : account
      )
    }
  }
  if (codex) {
    result.codexWorkspaceAccounts = assignWorkspaceAccount(
      settings.codexWorkspaceAccounts,
      settings.codexManagedAccounts,
      codex,
      'Codex'
    )
  }
  return result
}
