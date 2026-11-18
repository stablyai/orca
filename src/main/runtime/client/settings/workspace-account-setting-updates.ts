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
    claudeWorkspaceAccounts?: Record<string, string>
    codexWorkspaceAccounts?: Record<string, string>
  }
): Partial<GlobalSettings> {
  const result: Partial<GlobalSettings> = {}
  const claude = updates.claudeWorkspaceAccount
  const codex = updates.codexWorkspaceAccount
  for (const provider of ['claude', 'codex'] as const) {
    const assignment = provider === 'claude' ? claude : codex
    const bulk = updates[`${provider}WorkspaceAccounts`]
    if (assignment && bulk !== undefined) {
      throw new Error(`Choose either a ${provider} workspace assignment or a complete binding map.`)
    }
    let bindings = settings[`${provider}WorkspaceAccounts`]
    if (bulk !== undefined) {
      bindings = {}
      for (const [workspaceId, accountId] of Object.entries(bulk)) {
        bindings = assignWorkspaceAccount(
          bindings,
          settings[`${provider}ManagedAccounts`],
          { workspaceId, accountId },
          provider
        )
      }
    } else if (assignment) {
      bindings = assignWorkspaceAccount(
        bindings,
        settings[`${provider}ManagedAccounts`],
        assignment,
        provider
      )
    } else {
      continue
    }
    result[`${provider}WorkspaceAccounts`] = bindings
    if (provider === 'claude') {
      const assigned = new Set(Object.values(bindings ?? {}))
      result.claudeManagedAccounts = (settings.claudeManagedAccounts ?? []).map((account) =>
        assigned.has(account.id) ? { ...account, privateHistory: true } : account
      )
    }
  }
  return result
}
