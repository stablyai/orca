import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import type { GrokManagedAccount } from '../../shared/grok-account-types'

export type GrokAccountIndex = {
  version: 1
  accounts: GrokManagedAccount[]
  activeAccountId: string | null
}

export function getGrokAccountsRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'grok-accounts')
}

export function readGrokAccountIndex(): GrokAccountIndex {
  const empty: GrokAccountIndex = { version: 1, accounts: [], activeAccountId: null }
  if (!hasAppEnvironment()) {
    return empty
  }
  const path = join(getGrokAccountsRoot(), 'accounts.json')
  if (!existsSync(path)) {
    return empty
  }
  if (
    lstatSync(getGrokAccountsRoot()).isSymbolicLink() ||
    !lstatSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  ) {
    throw new Error('Saved Grok account storage is not owned by Orca')
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('accounts' in value) ||
    !Array.isArray(value.accounts) ||
    !('activeAccountId' in value) ||
    !(value.activeAccountId === null || typeof value.activeAccountId === 'string')
  ) {
    throw new Error('Unable to read saved Grok accounts')
  }
  const accounts: GrokManagedAccount[] = []
  for (const item of value.accounts) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      !('email' in item) ||
      typeof item.email !== 'string' ||
      !('userId' in item) ||
      typeof item.userId !== 'string' ||
      !('teamId' in item) ||
      !(item.teamId === null || typeof item.teamId === 'string')
    ) {
      throw new Error('Unable to read saved Grok accounts')
    }
    accounts.push({ id: item.id, email: item.email, userId: item.userId, teamId: item.teamId })
  }
  if (value.activeAccountId !== null && !accounts.some((a) => a.id === value.activeAccountId)) {
    throw new Error('The selected Grok account is missing')
  }
  return { version: 1, accounts, activeAccountId: value.activeAccountId }
}

export function getOwnedGrokAccountHome(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Invalid Grok account')
  }
  const root = getGrokAccountsRoot()
  const home = join(root, id)
  const marker = join(home, '.orca-grok-account')
  if (
    lstatSync(root).isSymbolicLink() ||
    !lstatSync(home).isDirectory() ||
    lstatSync(home).isSymbolicLink() ||
    realpathSync(home) !== join(realpathSync(root), id) ||
    !lstatSync(marker).isFile() ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, 'utf8').trim() !== id
  ) {
    throw new Error('Grok account folder is not owned by Orca')
  }
  const auth = join(home, 'auth.json')
  if (existsSync(auth) && (!lstatSync(auth).isFile() || lstatSync(auth).isSymbolicLink())) {
    throw new Error('Grok account sign-in file is not owned by Orca')
  }
  return home
}

export function getSelectedGrokAccountHome(): string | null {
  const index = readGrokAccountIndex()
  return index.activeAccountId === null ? null : getOwnedGrokAccountHome(index.activeAccountId)
}

export function getManagedGrokAccountHomes(): string[] {
  try {
    return readGrokAccountIndex().accounts.flatMap((account) => {
      try {
        return [getOwnedGrokAccountHome(account.id)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
