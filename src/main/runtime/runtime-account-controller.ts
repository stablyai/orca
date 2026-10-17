import type { ClaudeAccountService } from '../claude-accounts/service'
import { hasAppEnvironment } from '../../shared/app-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest,
  CodexRateLimitAccountsState,
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import type {
  CodexAccountService,
  CodexResetCreditRejectedBeforeProviderReason
} from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import {
  hostAccountLaunchEnvFor,
  hostAccountsManagedByDesktopMessage,
  type HostAccountLaunchEnv
} from '../../shared/host-account-launch-env'
import { FirstHostLaunchEnvGate } from './first-host-launch-env-gate'

export type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type AccountsSnapshot = {
  opencode?: ManagedDataAccountsState
  devin?: ManagedDataAccountsState
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexRateLimitResetRpcResult = {
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
} & (
  | { outcome: CodexRateLimitResetOutcome }
  | {
      status: 'rejectedBeforeProvider'
      retryDisposition: 'discardAttempt'
      reason: CodexResetCreditRejectedBeforeProviderReason
    }
)

export class RuntimeAccountController {
  private services: RuntimeAccountServices | null = null
  private commitMessageAgentEnvironment: CommitMessageAgentEnvironmentResolvers | null = null
  /** Pushed by the desktop that owns this host's accounts; held in memory, re-pushed on connect. */
  private hostLaunchEnv: HostAccountLaunchEnv | null = null
  private persistHostLaunchEnv: ((launchEnv: HostAccountLaunchEnv) => void) | null = null
  private readonly firstHostLaunchEnv = new FirstHostLaunchEnvGate()
  private refreshClaudeProfile: ((launchEnv: HostAccountLaunchEnv) => Promise<void>) | null = null

  setServices(services: RuntimeAccountServices): void {
    this.services = services
  }

  setCommitMessageAgentEnvironment(resolvers: CommitMessageAgentEnvironmentResolvers): void {
    this.commitMessageAgentEnvironment = resolvers
  }

  getCommitMessageAgentEnvironment(): CommitMessageAgentEnvironmentResolvers | undefined {
    if (this.commitMessageAgentEnvironment) {
      return this.commitMessageAgentEnvironment
    }
    if (!this.hostLaunchEnv && !this.firstHostLaunchEnv.armed) {
      return undefined
    }
    const currentHostLaunchEnv = async (agent: string): Promise<HostAccountLaunchEnv | null> => {
      await this.prepareHostAgentLaunch(agent)
      return this.hostLaunchEnv
    }
    return {
      prepareForCodexLaunch: async () =>
        (await currentHostLaunchEnv('codex'))?.terminal.CODEX_HOME ?? null,
      prepareForClaudeLaunch: async () => {
        const claude = (await currentHostLaunchEnv('claude'))?.claude ?? {}
        return {
          configDir: claude.CLAUDE_CONFIG_DIR ?? '',
          envPatch: { ...claude },
          provenance: 'desktop-host-launch-env'
        }
      }
    }
  }

  /** Refused where this host has account services of its own: they already decide every launch. */
  setHostLaunchEnv(launchEnv: HostAccountLaunchEnv): void {
    if (this.services) {
      throw new Error('This host manages its own provider accounts.')
    }
    this.hostLaunchEnv = launchEnv
    this.firstHostLaunchEnv.settle()
    try {
      this.persistHostLaunchEnv?.(launchEnv)
    } catch (error) {
      // Why not refuse: the env already applies; only a restart before the next push loses it.
      console.warn('[accounts] Could not save the host account env:', error)
    }
  }

  /** orcad's store: starts from the last pushed env, so launches before a reconnect keep it. */
  restoreHostLaunchEnv(
    saved: HostAccountLaunchEnv | null,
    persist: (launchEnv: HostAccountLaunchEnv) => void,
    options: {
      expectDesktopPush?: boolean
      refreshClaudeProfile?: (launchEnv: HostAccountLaunchEnv) => Promise<void>
    } = {}
  ): void {
    this.persistHostLaunchEnv = persist
    if (this.services) {
      return
    }
    this.refreshClaudeProfile = options.refreshClaudeProfile ?? null
    if (saved) {
      this.hostLaunchEnv = saved
      return
    }
    if (options.expectDesktopPush) {
      this.firstHostLaunchEnv.arm()
    }
  }

  /** Before a launch for `agent` this host starts: a fresh WSL host's first account push (once,
   *  briefly), then a refresh of the selected Claude folder, as the desktop's launches do. */
  async prepareHostAgentLaunch(agent: string | null | undefined): Promise<void> {
    await this.firstHostLaunchEnv.wait()
    if (agent !== 'claude' || !this.refreshClaudeProfile) {
      return
    }
    // Why twice at most: a switch during the refresh would launch on a folder never refreshed.
    for (let pass = 0, env = this.hostLaunchEnv; env && pass < 2; pass++) {
      await this.refreshClaudeProfile(env)
      if (this.hostLaunchEnv === env) {
        return
      }
      env = this.hostLaunchEnv
    }
  }

  /** The desktop-selected account env for a process `agent` starts here; empty when none. */
  hostLaunchEnvFor(agent: string | null | undefined): Readonly<Record<string, string>> {
    return hostAccountLaunchEnvFor(this.hostLaunchEnv, agent)
  }

  getClaudeConfigDirectory(target: ClaudeAccountSelectionTarget): string | null {
    return this.services?.claudeAccounts.getRuntimeConfigDir(target) ?? null
  }

  getSnapshot(): AccountsSnapshot {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireServices()
    return {
      ...this.dataAccountsSnapshot(),
      claude: claudeAccounts.listAccounts(),
      codex: codexAccounts.listAccounts(),
      rateLimits: rateLimits.getState()
    }
  }

  dataAccountsSnapshot(): Pick<AccountsSnapshot, 'opencode' | 'devin'> {
    if (!hasAppEnvironment()) {
      return {}
    }
    const service = getManagedDataAccountService()
    return { opencode: service.list('opencode'), devin: service.list('devin') }
  }

  addDataFromHome(
    provider: ManagedDataAccountProvider,
    sourceDataHome: string,
    label: string
  ): Promise<ManagedDataAccountsState> {
    return getManagedDataAccountService().add(provider, sourceDataHome, label)
  }

  selectData(
    provider: ManagedDataAccountProvider,
    accountId: string | null
  ): Promise<ManagedDataAccountsState> {
    return getManagedDataAccountService().select(provider, accountId)
  }

  removeData(
    provider: ManagedDataAccountProvider,
    accountId: string
  ): Promise<ManagedDataAccountsState> {
    return getManagedDataAccountService().remove(provider, accountId)
  }

  async refreshForMobile(): Promise<void> {
    const { rateLimits } = this.requireServices()
    await Promise.allSettled([
      rateLimits.refresh(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  async refreshForMobileSubscriber(): Promise<void> {
    const { rateLimits } = this.requireServices()
    await Promise.allSettled([
      rateLimits.refreshIfStale(),
      rateLimits.fetchInactiveClaudeAccountsOnOpen(),
      rateLimits.fetchInactiveCodexAccountsOnOpen()
    ])
  }

  selectClaude(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.selectAccount(accountId)
  }

  selectCodex(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.selectAccount(accountId)
  }

  selectCodexForTarget(
    accountId: string | null,
    target: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.selectAccountForTarget(accountId, target)
  }

  async consumeCodexResetCredit(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexRateLimitResetRpcResult> {
    const { claudeAccounts, codexAccounts } = this.requireServices()
    const result = await codexAccounts.consumeRateLimitResetCredit(idempotencyKey, expectedScope)
    const snapshot = {
      claude: claudeAccounts.listAccounts(),
      codex: result.codex,
      rateLimits: result.rateLimits
    }
    if ('status' in result) {
      return {
        status: result.status,
        retryDisposition: result.retryDisposition,
        reason: result.reason,
        scope: result.scope,
        snapshot
      }
    }
    return { outcome: result.outcome, scope: result.scope, snapshot }
  }

  removeClaude(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.removeAccount(accountId)
  }

  beginClaudeSignIn(request: ClaudeSignInRequest): Promise<ClaudeAccountSignIn> {
    return this.requireServices().claudeAccounts.beginSignIn(request)
  }

  finishClaudeSignIn(
    signIn: Omit<ClaudeAccountSignIn, 'configDir'>
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.finishSignIn(signIn)
  }

  cancelClaudeSignIn(signIn: Omit<ClaudeAccountSignIn, 'configDir'>): Promise<void> {
    return this.requireServices().claudeAccounts.cancelSignIn(signIn)
  }

  removeCodex(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.removeAccount(accountId)
  }

  addCodexFromHome(
    sourceHome: string,
    target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
  ): Promise<CodexRateLimitAccountsState> {
    return this.requireServices().codexAccounts.addAccountFromHome(sourceHome, target)
  }

  onChanged(listener: (snapshot: AccountsSnapshot) => void): () => void {
    const services = this.requireServices()
    const unsubscribeData = hasAppEnvironment()
      ? getManagedDataAccountService().onChanged(() => listener(this.getSnapshot()))
      : () => {}
    const unsubscribeUsage = services.rateLimits.onStateChange((rateLimits) => {
      listener({
        ...this.dataAccountsSnapshot(),
        claude: services.claudeAccounts.listAccounts(),
        codex: services.codexAccounts.listAccounts(),
        rateLimits
      })
    })
    return () => {
      unsubscribeData()
      unsubscribeUsage()
    }
  }

  private requireServices(): RuntimeAccountServices {
    if (!this.services) {
      throw new Error(
        this.hostLaunchEnv
          ? hostAccountsManagedByDesktopMessage(this.hostLaunchEnv.wslDistro)
          : 'Account services are not configured on this runtime'
      )
    }
    return this.services
  }
}
