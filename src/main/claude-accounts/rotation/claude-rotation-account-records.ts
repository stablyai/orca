import type { Store } from '../../persistence/loading-store/store'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import {
  getManagedAccountDisplayName,
  type ManagedAccountDisplayNames
} from '../../../shared/agent-accounts/managed-account-display-names'
import { tokenHash } from './claude-rotation-keychain'
import type { RotationSwapDeps } from './claude-rotation-swap'

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

/** What a record says about its login; a pending swap compares these to tell if records moved. */
export function accountRecordFingerprint(
  settings: AccountRecordSettings,
  accountId: string
): string | null {
  const record = settings.claudeManagedAccounts.find((account) => account.id === accountId)
  if (!record) {
    return null
  }
  return tokenHash(
    JSON.stringify([
      record.email,
      record.organizationUuid ?? null,
      record.organizationName ?? null,
      record.authMethod ?? null,
      record.lastAuthenticatedAt ?? null,
      settings.managedAccountDisplayNames?.claude?.[accountId] ?? null
    ])
  )
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

/** Orca's account records as a swap sees them; they follow the logins between folders. */
export function rotationAccountRecords(
  store: Pick<Store, 'getSettings' | 'updateSettingsAndFlush'>
): NonNullable<RotationSwapDeps['records']> {
  return {
    fingerprint: (id) => accountRecordFingerprint(store.getSettings(), id),
    // Waits for the write: a journal marked done must not outlive records that never reached disk.
    exchange: async (a, b) => {
      const patch = swappedAccountRecords(store.getSettings(), a, b)
      if (!patch) {
        return true
      }
      try {
        await store.updateSettingsAndFlush(patch, { notifyListeners: true })
        return true
      } catch {
        return false
      }
    }
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
