import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  GrokManagedAccount,
  GrokManagedAccountSummary,
  GrokRateLimitAccountsState
} from '../../shared/types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { getSpawnArgsForWindows } from '../win32-utils'
import { readGrokAuthIdentity } from './grok-auth-file'
import {
  assertGrokManagedHomePath,
  createGrokManagedHome,
  ensureGrokManagedHomeForReauthentication,
  safeRemoveGrokManagedHome
} from './managed-home'

const LOGIN_TIMEOUT_MS = 120_000
const MAX_LOGIN_OUTPUT_CHARS = 4_000

export class GrokAccountService {
  // Why: account mutations spawn login and then write settings. Serializing
  // prevents overlapping add/remove/select calls from losing each other's updates.
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly rateLimits: Pick<RateLimitService, 'refreshGrokForAccountChange'>
  ) {
    this.normalizeActiveSelection()
  }

  listAccounts(): GrokRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  getActiveManagedHomePath(): string | null {
    this.normalizeActiveSelection()
    const settings = this.store.getSettings()
    const account = settings.grokManagedAccounts.find(
      (entry) => entry.id === settings.activeGrokManagedAccountId
    )
    if (!account) {
      return null
    }
    try {
      return assertGrokManagedHomePath(account.managedHomePath, account.id)
    } catch {
      return null
    }
  }

  getManagedHomePaths(): string[] {
    return this.store.getSettings().grokManagedAccounts.flatMap((account) => {
      try {
        return [assertGrokManagedHomePath(account.managedHomePath, account.id)]
      } catch {
        return []
      }
    })
  }

  async addAccount(): Promise<GrokRateLimitAccountsState> {
    return this.serializeMutation(() => this.doAddAccount())
  }

  async reauthenticateAccount(accountId: string): Promise<GrokRateLimitAccountsState> {
    return this.serializeMutation(() => this.doReauthenticateAccount(accountId))
  }

  async removeAccount(accountId: string): Promise<GrokRateLimitAccountsState> {
    return this.serializeMutation(() => this.doRemoveAccount(accountId))
  }

  async selectAccount(accountId: string | null): Promise<GrokRateLimitAccountsState> {
    return this.serializeMutation(() => this.doSelectAccount(accountId))
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async doAddAccount(): Promise<GrokRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHomePath = createGrokManagedHome(accountId)
    try {
      await this.runGrokLogin(managedHomePath)
      const email = this.readIdentityFromHome(managedHomePath, accountId)
      if (!email) {
        throw new Error('Grok login completed, but Orca could not resolve the account email.')
      }

      const now = Date.now()
      const account: GrokManagedAccount = {
        id: accountId,
        email,
        managedHomePath,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }
      const settings = this.store.getSettings()
      this.store.updateSettings({
        grokManagedAccounts: [...settings.grokManagedAccounts, account],
        activeGrokManagedAccountId: account.id
      })
      await this.rateLimits.refreshGrokForAccountChange()
      return this.getSnapshot()
    } catch (error) {
      safeRemoveGrokManagedHome(managedHomePath, accountId)
      throw error
    }
  }

  private async doReauthenticateAccount(accountId: string): Promise<GrokRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const managedHomePath = ensureGrokManagedHomeForReauthentication(account)
    await this.runGrokLogin(managedHomePath)
    const email = this.readIdentityFromHome(managedHomePath, accountId)
    if (!email) {
      throw new Error('Grok login completed, but Orca could not resolve the account email.')
    }

    const now = Date.now()
    const settings = this.store.getSettings()
    this.store.updateSettings({
      grokManagedAccounts: settings.grokManagedAccounts.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              email,
              updatedAt: now,
              lastAuthenticatedAt: now
            }
          : entry
      )
    })
    await this.rateLimits.refreshGrokForAccountChange()
    return this.getSnapshot()
  }

  private async doRemoveAccount(accountId: string): Promise<GrokRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextActiveAccountId =
      settings.activeGrokManagedAccountId === accountId ? null : settings.activeGrokManagedAccountId

    this.store.updateSettings({
      grokManagedAccounts: settings.grokManagedAccounts.filter((entry) => entry.id !== accountId),
      activeGrokManagedAccountId: nextActiveAccountId
    })
    safeRemoveGrokManagedHome(account.managedHomePath, account.id)
    await this.rateLimits.refreshGrokForAccountChange()
    return this.getSnapshot()
  }

  private async doSelectAccount(accountId: string | null): Promise<GrokRateLimitAccountsState> {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }
    const settings = this.store.getSettings()
    if (settings.activeGrokManagedAccountId === accountId) {
      return this.getSnapshot()
    }
    this.store.updateSettings({
      activeGrokManagedAccountId: accountId
    })
    await this.rateLimits.refreshGrokForAccountChange()
    return this.getSnapshot()
  }

  private getSnapshot(): GrokRateLimitAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.grokManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: settings.activeGrokManagedAccountId
    }
  }

  private toSummary(account: GrokManagedAccount): GrokManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
      managedHomePath: account.managedHomePath,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt
    }
  }

  private requireAccount(accountId: string): GrokManagedAccount {
    const account = this.store
      .getSettings()
      .grokManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Grok rate limit account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    if (
      settings.activeGrokManagedAccountId &&
      !settings.grokManagedAccounts.some(
        (account) => account.id === settings.activeGrokManagedAccountId
      )
    ) {
      this.store.updateSettings({ activeGrokManagedAccountId: null })
    }
  }

  private async runGrokLogin(managedHomePath: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('grok', ['login'])
      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          GROK_HOME: managedHomePath
        }
      })

      let settled = false
      let output = ''
      let timeout: ReturnType<typeof setTimeout> | null = null

      const appendOutput = (chunk: Buffer | string): void => {
        output = `${output}${chunk.toString()}`
        if (output.length > MAX_LOGIN_OUTPUT_CHARS) {
          output = output.slice(-MAX_LOGIN_OUTPUT_CHARS)
        }
      }

      const cleanupListeners = (): void => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        child.stdout?.off('data', appendOutput)
        child.stderr?.off('data', appendOutput)
        child.off('error', onError)
        child.off('close', onClose)
      }

      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        cleanupListeners()
        callback()
      }

      timeout = setTimeout(() => {
        child.kill()
        settle(() => {
          rejectPromise(new Error('Grok sign-in took too long to finish. Please try again.'))
        })
      }, LOGIN_TIMEOUT_MS)

      const onError = (error: Error): void => {
        settle(() => {
          const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
          rejectPromise(new Error(isEnoent ? 'Grok CLI not found.' : error.message))
        })
      }

      const onClose = (code: number | null): void => {
        settle(() => {
          if (code === 0) {
            resolvePromise()
            return
          }
          const trimmedOutput = output.trim()
          rejectPromise(
            new Error(
              trimmedOutput
                ? `Grok login failed: ${trimmedOutput}`
                : `Grok login exited with code ${code ?? 'unknown'}.`
            )
          )
        })
      }

      child.stdout?.on('data', appendOutput)
      child.stderr?.on('data', appendOutput)
      child.on('error', onError)
      child.on('close', onClose)
    })
  }

  private readIdentityFromHome(managedHomePath: string, accountId: string): string | null {
    return readGrokAuthIdentity(assertGrokManagedHomePath(managedHomePath, accountId))
  }
}
