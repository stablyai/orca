import { randomUUID } from 'node:crypto'
import type {
  ClaudeAccountSignIn,
  ClaudeApiEndpointAccountRequest,
  ClaudeApiEndpointSummary,
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../shared/managed-account-types'
import {
  normalizeClaudeApiEndpointRequest,
  readClaudeApiEndpointToken,
  writeClaudeApiEndpoint
} from './claude-api-endpoint'
import { claudeStateFile, readClaudeFolderLogin } from './claude-account-folder'
import type {
  ClaudeAccountRuntime,
  ClaudeAccountSelection,
  ClaudeAccountStore,
  ClaudeAccountUsage
} from './claude-account-selection'
import type { ClaudeCommandConfig } from './claude-command-process'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'
import {
  getClaudeSelectionTargetForAccount,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

export const CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE =
  'Claude has not finished signing in to this account yet. Finish the sign-in in the terminal, then try again.'
const CLAUDE_LOGIN_WITHOUT_ACCOUNT_MESSAGE =
  'Claude login completed, but Orca could not resolve the account email.'

/** Publish accounts only after login, so abandoned sign-ins never appear in the list. */
export class ClaudeAccountRegistration {
  constructor(
    private readonly deps: {
      store: ClaudeAccountStore
      rateLimits: ClaudeAccountUsage
      runtimeAuth: ClaudeAccountRuntime
      selection: ClaudeAccountSelection
    }
  ) {}

  async begin(request: ClaudeSignInRequest): Promise<ClaudeAccountSignIn> {
    const { accountId, target, folder } = await this.prepare(request)
    return { accountId, configDir: folder.configDir, ...target }
  }

  async signIn(
    request: ClaudeSignInRequest,
    login: (folder: ClaudeCommandConfig) => Promise<void>
  ): Promise<ClaudeRateLimitAccountsState> {
    const { accountId, target, folder } = await this.prepare(request)
    const signIn = { accountId, ...target }
    try {
      await login({
        windowsPath: folder.readPath,
        linuxPath: target.runtime === 'wsl' ? folder.configDir : null,
        wslDistro: target.runtime === 'wsl' ? (target.wslDistro ?? null) : null
      })
      return await this.finish(signIn, CLAUDE_LOGIN_WITHOUT_ACCOUNT_MESSAGE)
    } catch (error) {
      // Preserve the sign-in error if cleanup also fails.
      await this.cancel(signIn).catch((cleanupError: unknown) =>
        console.warn(
          '[claude-accounts] Could not delete an unfinished sign-in folder:',
          cleanupError
        )
      )
      throw error
    }
  }

  private async prepare(request: ClaudeSignInRequest) {
    const saved = request.accountId ? this.deps.selection.requireAccount(request.accountId) : null
    const target = saved ? getClaudeSelectionTargetForAccount(saved) : signInTarget(request)
    const accountId = saved?.id ?? randomUUID()
    const folder = await this.deps.runtimeAuth.prepareAccountFolder(accountId, target)
    return { accountId, target, folder }
  }

  async cancel(signIn: Omit<ClaudeAccountSignIn, 'configDir'>): Promise<void> {
    if (!this.deps.selection.findAccount(signIn.accountId)) {
      await this.deps.runtimeAuth.removeAccountFolder(signIn.accountId, signInTarget(signIn))
    }
  }

  /** Save an endpoint account, or replace a saved one's endpoint when `accountId` is given. */
  async saveApiEndpoint(
    request: ClaudeApiEndpointAccountRequest,
    accountId?: string
  ): Promise<ClaudeRateLimitAccountsState> {
    const { store, rateLimits, runtimeAuth, selection } = this.deps
    const saved = accountId ? selection.requireAccount(accountId) : null
    if (saved && saved.authMethod !== 'api-endpoint') {
      throw new Error('That Claude account signs in with a subscription, not a token.')
    }
    const savedToken = saved
      ? readClaudeApiEndpointToken(runtimeAuth.router.accountHome(saved.id))
      : null
    const endpoint = normalizeClaudeApiEndpointRequest(request, savedToken)
    const accounts = store.getSettings().claudeManagedAccounts
    if (
      accounts.some((entry) => entry.id !== saved?.id && endpointAccountMatches(entry, endpoint))
    ) {
      throw new Error('This endpoint account is already added.')
    }
    const id = saved?.id ?? randomUUID()
    // Endpoint accounts run on the host; a WSL guest cannot read the host folder's token.
    const target = { runtime: 'host' } as const
    const folder = await runtimeAuth.prepareAccountFolder(id, target)
    let apiEndpoint: ClaudeApiEndpointSummary
    try {
      apiEndpoint = writeClaudeApiEndpoint(folder.readPath, endpoint)
      // Set up again so the folder's settings carry the endpoint before any launch.
      await runtimeAuth.prepareAccountFolder(id, target)
    } catch (error) {
      if (!saved) {
        await runtimeAuth.removeAccountFolder(id, target).catch(() => {})
      }
      throw error
    }
    const now = Date.now()
    selection.saveSettings({
      claudeManagedAccounts: [
        ...accounts.filter((entry) => entry.id !== id),
        {
          id,
          email: endpoint.label,
          managedAuthPath: folder.readPath,
          managedAuthRuntime: 'host',
          wslDistro: null,
          wslLinuxAuthPath: null,
          authMethod: 'api-endpoint',
          apiEndpoint,
          createdAt: saved?.createdAt ?? now,
          updatedAt: now,
          lastAuthenticatedAt: now
        }
      ]
    })
    rateLimits.evictInactiveClaudeCache(id)
    await runtimeAuth.syncForCurrentSelection(target)
    return selection.list()
  }

  async finish(
    signIn: Omit<ClaudeAccountSignIn, 'configDir'>,
    notSignedInMessage = CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE
  ): Promise<ClaudeRateLimitAccountsState> {
    const { store, rateLimits, runtimeAuth, selection } = this.deps
    const saved = selection.findAccount(signIn.accountId)
    const target = saved ? getClaudeSelectionTargetForAccount(saved) : signInTarget(signIn)
    // Merge onboarding into the state file created by login.
    const folder = await runtimeAuth.prepareAccountFolder(signIn.accountId, target)
    const login = readClaudeFolderLogin(claudeStateFile(folder.readPath))
    if (!login) {
      throw new Error(notSignedInMessage)
    }
    const accounts = store.getSettings().claudeManagedAccounts
    const scope = {
      managedAuthRuntime: target.runtime ?? 'host',
      wslDistro: target.runtime === 'wsl' ? (target.wslDistro ?? null) : null
    } as const
    if (
      !saved &&
      // Compare current folder logins; saved identities may be stale.
      findDuplicateClaudeAccount(selection.list().accounts, {
        email: login.email,
        organizationUuid: login.organizationUuid,
        ...scope
      })
    ) {
      await runtimeAuth.removeAccountFolder(signIn.accountId, target)
      throw new Error('This Claude account is already added.')
    }
    const now = Date.now()
    selection.saveSettings({
      claudeManagedAccounts: [
        ...accounts.filter((entry) => entry.id !== signIn.accountId),
        {
          id: signIn.accountId,
          email: login.email,
          organizationUuid: login.organizationUuid,
          organizationName: login.organizationName,
          managedAuthPath: folder.readPath,
          ...scope,
          wslLinuxAuthPath: target.runtime === 'wsl' ? folder.configDir : null,
          authMethod: 'subscription-oauth',
          createdAt: saved?.createdAt ?? now,
          updatedAt: now,
          lastAuthenticatedAt: now
        }
      ]
    })
    rateLimits.evictInactiveClaudeCache(signIn.accountId)
    // Publish the new folder for terminals using the selected account.
    await runtimeAuth.syncForCurrentSelection(target)
    selection.refreshUsage(undefined, target)
    return selection.list()
  }
}

function endpointAccountMatches(
  account: ClaudeManagedAccount,
  endpoint: ClaudeApiEndpointAccountRequest
): boolean {
  return (
    account.authMethod === 'api-endpoint' &&
    account.email.toLowerCase() === endpoint.label.toLowerCase() &&
    account.apiEndpoint?.baseUrl === endpoint.baseUrl
  )
}

function signInTarget(request: ClaudeAccountSelectionTarget): ClaudeAccountSelectionTarget {
  const target = normalizeClaudeAccountSelectionTarget(request)
  if (target.runtime === 'wsl' && !target.wslDistro) {
    throw new Error('Choose a WSL distro before signing in.')
  }
  return target.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: target.wslDistro }
    : { runtime: 'host' }
}
