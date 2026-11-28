import { randomUUID } from 'node:crypto'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../../shared/agent-accounts/managed-account-types'
import { claudeStateFile, isSameClaudeLogin, readClaudeFolderLogin } from './claude-account-folder'
import type {
  ClaudeAccountRuntime,
  ClaudeAccountSelection,
  ClaudeAccountStore,
  ClaudeAccountUsage
} from '../selection/claude-account-selection'
import type { ClaudeCommandConfig } from './claude-command-process'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'
import {
  getClaudeSelectionTargetForAccount,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from '../selection/runtime-selection'

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
      // A saved account may sign in again as itself even when another folder now shares its login.
      !(saved && isSameClaudeLogin(saved, login)) &&
      // Host rows list their folder login; WSL rows list their saved identity.
      findDuplicateClaudeAccount(
        selection.list().accounts.filter((entry) => entry.id !== signIn.accountId),
        { email: login.email, organizationUuid: login.organizationUuid, ...scope }
      )
    ) {
      if (!saved) {
        await runtimeAuth.removeAccountFolder(signIn.accountId, target)
        throw new Error('This Claude account is already added.')
      }
      // Claude already wrote this login into the account's folder, so the user must sign in again.
      throw new Error(
        `You signed in as ${describeLogin(login)}, which another Claude account already uses. Sign in again as ${describeLogin(saved)}.`
      )
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

function signInTarget(request: ClaudeAccountSelectionTarget): ClaudeAccountSelectionTarget {
  const target = normalizeClaudeAccountSelectionTarget(request)
  if (target.runtime === 'wsl' && !target.wslDistro) {
    throw new Error('Choose a WSL distro before signing in.')
  }
  return target.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: target.wslDistro }
    : { runtime: 'host' }
}

// Same-email rows differ only by organization, so name it when known.
function describeLogin(login: { email: string; organizationName?: string | null }): string {
  return login.organizationName ? `${login.email} (${login.organizationName})` : login.email
}
