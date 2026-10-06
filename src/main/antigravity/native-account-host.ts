import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../shared/antigravity-account-types'
import {
  createEncryptedAntigravityAccountStore,
  type AntigravityAccountStore
} from './native-account-store'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { AntigravityAccountService } from './native-account-service'
import { createAntigravityWslCredentialBackend } from './native-wsl-credential-backend'
import {
  resolveAntigravityWslTarget,
  type ResolvedAntigravityWslTarget
} from './native-wsl-account-target'
import {
  remainingAccountOperationMs,
  withAntigravityAccountOperation,
  type AntigravityAccountOperation
} from './native-account-operation'

export type AntigravityAccountAction = 'List' | 'AddCurrent' | 'Select' | 'Remove'
type AccountEntry = {
  service: AntigravityAccountService
  store: AntigravityAccountStore
  authority: ResolvedAntigravityWslTarget | null
  pending: Promise<unknown>
  needsVerification: boolean
}
const services = new Map<string, AccountEntry>()
export function getAntigravityAccountVaultPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'antigravity-accounts', 'vault')
}
export function getAntigravityWslAccountVaultRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'antigravity-accounts', 'wsl')
}
async function getAccountEntry(
  target: AntigravityAccountTarget,
  operation: AntigravityAccountOperation,
  mutation: boolean
): Promise<AccountEntry> {
  if (target.runtime === 'host' && (target.wslDistro || target.expectedAuthorityId)) {
    throw new Error('Invalid Host Antigravity account target')
  }
  const authority =
    target.runtime === 'wsl' ? await resolveAntigravityWslTarget(target, operation) : null
  if (authority && mutation && target.expectedAuthorityId !== authority.authorityId) {
    throw new Error(
      'The Antigravity WSL account authority changed; reload Accounts before changing it.'
    )
  }
  remainingAccountOperationMs(operation)
  const key = authority?.authorityId ?? 'host'
  const cached = services.get(key)
  if (cached) {
    return cached
  }
  const store = authority
    ? createEncryptedAntigravityAccountStore(
        join(getAntigravityWslAccountVaultRoot(), authority.authorityId, 'vault'),
        { authority }
      )
    : createEncryptedAntigravityAccountStore(getAntigravityAccountVaultPath())
  const backend = authority
    ? createAntigravityWslCredentialBackend(authority)
    : createAntigravityHostCredentialBackend(getAppEnvironment().getPath('home'))
  const entry = {
    service: new AntigravityAccountService(store, backend),
    store,
    authority,
    pending: Promise.resolve(),
    needsVerification: false
  }
  services.set(key, entry)
  return entry
}
function serializeEntry<T>(
  entry: AccountEntry,
  operation: AntigravityAccountOperation,
  run: () => Promise<T>
): Promise<T> {
  const next = entry.pending.then(async () => {
    remainingAccountOperationMs(operation)
    return run()
  })
  entry.pending = next.catch(() => undefined)
  return next
}
export function runAntigravityAccountOperation(
  target: AntigravityAccountTarget,
  action: AntigravityAccountAction,
  accountId?: string
): Promise<AntigravityAccountState> {
  return withAntigravityAccountOperation(async (operation) => {
    if ((action === 'Select' || action === 'Remove') && !accountId) {
      throw new Error('Antigravity account ID is required')
    }
    const entry = await getAccountEntry(target, operation, action !== 'List')
    return serializeEntry(entry, operation, async () => {
      if (entry.needsVerification && action !== 'List') {
        throw new Error(
          'Refresh Accounts to verify the previous Antigravity operation before retrying'
        )
      }
      try {
        let state: AntigravityAccountState
        switch (action) {
          case 'List':
            state = await entry.service.listAccounts(operation)
            break
          case 'AddCurrent':
            state = await entry.service.addCurrentAccount(operation)
            break
          case 'Select':
            state = await entry.service.selectAccount(accountId ?? '', operation)
            break
          case 'Remove':
            state = await entry.service.removeAccount(accountId ?? '', operation)
            break
        }
        remainingAccountOperationMs(operation)
        entry.needsVerification = false
        return entry.authority
          ? {
              ...state,
              resolvedTarget: {
                runtime: 'wsl',
                wslDistro: entry.authority.distro,
                authorityId: entry.authority.authorityId
              }
            }
          : state
      } catch (error) {
        if (entry.authority && action !== 'List') {
          entry.needsVerification = true
        }
        throw error
      }
    })
  })
}
export async function prepareAntigravityAccountTargetForLaunch(
  target: AntigravityAccountTarget,
  operation: AntigravityAccountOperation
): Promise<ResolvedAntigravityWslTarget | null> {
  const entry = await getAccountEntry(target, operation, false)
  return serializeEntry(entry, operation, async () => {
    if (entry.needsVerification) {
      throw new Error(
        'Refresh Accounts to verify the previous Antigravity operation before launching'
      )
    }
    if ((await entry.store.read(operation)).selectedAccountId) {
      await entry.service.prepareForLaunch(operation)
    }
    remainingAccountOperationMs(operation)
    return entry.authority
  })
}
