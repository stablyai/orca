import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import {
  getManagedAccountDisplayName,
  type ManagedAccountDisplayNames
} from '../../../shared/agent-accounts/managed-account-display-names'

type AccountRecordSettings = {
  claudeManagedAccounts: ClaudeManagedAccount[]
  managedAccountDisplayNames?: ManagedAccountDisplayNames
}

/** The sign-in identity moves with the login; the record's id, folder and creation time stay. */
function withIdentityOf(
  account: ClaudeManagedAccount,
  from: ClaudeManagedAccount
): ClaudeManagedAccount {
  return {
    ...account,
    email: from.email,
    organizationUuid: from.organizationUuid,
    organizationName: from.organizationName,
    authMethod: from.authMethod,
    lastAuthenticatedAt: from.lastAuthenticatedAt
  }
}

/** The folders traded logins: their saved identities and names trade too, so names follow logins. */
export function swappedAccountRecords(
  settings: AccountRecordSettings,
  a: string,
  b: string
): Partial<AccountRecordSettings> | null {
  const recordA = settings.claudeManagedAccounts.find((account) => account.id === a)
  const recordB = settings.claudeManagedAccounts.find((account) => account.id === b)
  if (!recordA || !recordB) {
    return null
  }
  const claudeManagedAccounts = settings.claudeManagedAccounts.map((account) =>
    account.id === a
      ? withIdentityOf(account, recordB)
      : account.id === b
        ? withIdentityOf(account, recordA)
        : account
  )
  const names = { ...settings.managedAccountDisplayNames?.claude }
  const nameA = names[a]
  const nameB = names[b]
  delete names[a]
  delete names[b]
  if (nameB !== undefined) {
    names[a] = nameB
  }
  if (nameA !== undefined) {
    names[b] = nameA
  }
  return {
    claudeManagedAccounts,
    managedAccountDisplayNames: { ...settings.managedAccountDisplayNames, claude: names }
  }
}

export function claudeAccountLabel(
  settings: AccountRecordSettings,
  accountId: string
): string | null {
  return (
    getManagedAccountDisplayName(settings.managedAccountDisplayNames, 'claude', accountId) ??
    settings.claudeManagedAccounts.find((account) => account.id === accountId)?.email ??
    null
  )
}
