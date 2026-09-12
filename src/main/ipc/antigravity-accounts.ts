import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AntigravityManagedAccount } from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getAntigravityAccountStatus } from '../antigravity-accounts/status'
import { addAntigravityAccountViaBrowser } from '../antigravity-accounts/managed-oauth'
import {
  createAntigravityTokenStore,
  type AntigravityTokenStore
} from '../antigravity-accounts/token-store'
import { fetchAntigravityManagedAccountUsage } from '../rate-limits/antigravity-managed-account-fetch'

export type AntigravityAccountUsageEntry = {
  account: AntigravityManagedAccount
  usage: ProviderRateLimits | null
}

type AntigravityAccountsIpcDeps = {
  getSettings: () => GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => void
  tokenStore?: AntigravityTokenStore
}

export function registerAntigravityAccountHandlers(deps?: AntigravityAccountsIpcDeps): void {
  const tokenStore = deps?.tokenStore ?? createAntigravityTokenStore()

  ipcMain.handle('antigravityAccounts:getStatus', () => getAntigravityAccountStatus())

  if (!deps) {
    return
  }

  ipcMain.handle(
    'antigravityAccounts:addAccount',
    async (): Promise<{ ok: boolean; email?: string; error?: string }> => {
      try {
        const grant = await addAntigravityAccountViaBrowser()
        await tokenStore.write(grant.accountId, {
          refreshToken: grant.refreshToken,
          accessToken: grant.accessToken,
          expiryDate: grant.expiryDate
        })
        const now = Date.now()
        const existing = deps.getSettings().antigravityManagedAccounts ?? []
        const account: AntigravityManagedAccount = {
          id: grant.accountId,
          email: grant.email,
          projectId: grant.projectId,
          createdAt: now,
          updatedAt: now,
          lastAuthenticatedAt: now
        }
        deps.updateSettings({ antigravityManagedAccounts: [...existing, account] })
        return { ok: true, email: grant.email }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown sign-in error' }
      }
    }
  )

  ipcMain.handle(
    'antigravityAccounts:removeAccount',
    async (_event, accountId: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (typeof accountId !== 'string' || !accountId) {
        return { ok: false, error: 'Invalid account id' }
      }
      try {
        await tokenStore.remove(accountId)
        const existing = deps.getSettings().antigravityManagedAccounts ?? []
        deps.updateSettings({
          antigravityManagedAccounts: existing.filter((account) => account.id !== accountId)
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to remove account' }
      }
    }
  )

  ipcMain.handle(
    'antigravityAccounts:getManagedUsage',
    async (): Promise<AntigravityAccountUsageEntry[]> => {
      const accounts = deps.getSettings().antigravityManagedAccounts ?? []
      return Promise.all(
        accounts.map(async (account) => ({
          account,
          usage: await fetchAntigravityManagedAccountUsage(account, tokenStore)
        }))
      )
    }
  )
}
