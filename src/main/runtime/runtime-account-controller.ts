import type { ClaudeAccountService } from '../claude-accounts/service'
import type {
  CodexAccountService,
  CodexResetCreditRejectedBeforeProviderReason
} from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { RateLimitService } from '../rate-limits/service'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import type { Store } from '../persistence'
import { GrokResetCreditLedger } from '../rate-limits/grok-reset-credit-ledger'

export type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
}

export type AccountsSnapshot = {
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

export type GrokRateLimitResetRpcResult = {
  outcome: CodexRateLimitResetOutcome
  snapshot: AccountsSnapshot
}

export class RuntimeAccountController {
  private services: RuntimeAccountServices | null = null
  private commitMessageAgentEnvironment: CommitMessageAgentEnvironmentResolvers | null = null
  private grokResetLedger: GrokResetCreditLedger | null = null
  private grokResetPromiseByKey = new Map<string, Promise<GrokRateLimitResetRpcResult>>()
  private grokResetInFlight: Promise<GrokRateLimitResetRpcResult> | null = null

  constructor(private readonly getStore: () => Store | null = () => null) {}

  setServices(services: RuntimeAccountServices): void {
    this.services = services
  }

  setCommitMessageAgentEnvironment(resolvers: CommitMessageAgentEnvironmentResolvers): void {
    this.commitMessageAgentEnvironment = resolvers
  }

  getCommitMessageAgentEnvironment(): CommitMessageAgentEnvironmentResolvers | undefined {
    return this.commitMessageAgentEnvironment ?? undefined
  }

  getClaudeConfigDirectory(target: ClaudeAccountSelectionTarget): string | null {
    return this.services?.claudeAccounts.getRuntimeConfigDir(target) ?? null
  }

  getSnapshot(): AccountsSnapshot {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireServices()
    return {
      claude: claudeAccounts.listAccounts(),
      codex: codexAccounts.listAccounts(),
      rateLimits: rateLimits.getState()
    }
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

  consumeGrokResetCredit(idempotencyKey: string): Promise<GrokRateLimitResetRpcResult> {
    const ledger = this.requireGrokResetLedger()
    if (ledger.error) {
      return Promise.reject(ledger.error)
    }
    const existing = ledger.get(idempotencyKey)
    if (existing?.state === 'settled') {
      return Promise.resolve(this.grokResetResult(existing.outcome))
    }
    const tracked = this.grokResetPromiseByKey.get(idempotencyKey)
    if (tracked) {
      return tracked
    }
    let promise: Promise<GrokRateLimitResetRpcResult>
    if (existing?.state === 'providerPending') {
      promise = this.reconcilePendingGrokReset(idempotencyKey, ledger)
    } else {
      ledger.markProviderPending(
        idempotencyKey,
        this.requireServices().rateLimits.getState().grok?.weekly ?? null
      )
      const operation = this.grokResetInFlight ?? this.startGrokResetOperation()
      promise = operation.then((result) => {
        ledger.markSettled(idempotencyKey, result.outcome)
        return result
      })
    }
    this.grokResetPromiseByKey.set(idempotencyKey, promise)
    const clearTrackedPromise = (): void => {
      if (this.grokResetPromiseByKey.get(idempotencyKey) === promise) {
        this.grokResetPromiseByKey.delete(idempotencyKey)
      }
    }
    void promise.then(clearTrackedPromise, clearTrackedPromise)
    return promise
  }

  private startGrokResetOperation(): Promise<GrokRateLimitResetRpcResult> {
    const operation = this.consumeGrokResetCreditOnce()
    this.grokResetInFlight = operation
    const clearInFlight = (): void => {
      if (this.grokResetInFlight === operation) {
        this.grokResetInFlight = null
      }
    }
    void operation.then(clearInFlight, clearInFlight)
    return operation
  }

  private async consumeGrokResetCreditOnce(): Promise<GrokRateLimitResetRpcResult> {
    const { rateLimits } = this.requireServices()
    const { outcome } = await rateLimits.consumeGrokRateLimitResetCredit()
    return this.grokResetResult(outcome)
  }

  private async reconcilePendingGrokReset(
    idempotencyKey: string,
    ledger: GrokResetCreditLedger
  ): Promise<GrokRateLimitResetRpcResult> {
    const { rateLimits } = this.requireServices()
    const pending = ledger.get(idempotencyKey)
    await rateLimits.refreshGrok()
    const grok = rateLimits.getState().grok
    const preOperationWeekly =
      pending?.state === 'providerPending' ? pending.preOperationWeekly : undefined
    const resetCompleted =
      grok?.status === 'ok' &&
      preOperationWeekly != null &&
      preOperationWeekly.usedPercent > 0 &&
      grok.weekly != null &&
      grok.weekly.usedPercent <= 0
    if (resetCompleted) {
      ledger.markSettled(idempotencyKey, 'reset')
      return this.grokResetResult('reset')
    }
    const operation = this.grokResetInFlight ?? this.startGrokResetOperation()
    const result = await operation
    if (result.outcome === 'nothingToReset' && result.snapshot.rateLimits.grok?.status !== 'ok') {
      throw new Error('The Grok reset outcome is unknown; retry the same request.')
    }
    ledger.markSettled(idempotencyKey, result.outcome)
    return result
  }

  private grokResetResult(outcome: CodexRateLimitResetOutcome): GrokRateLimitResetRpcResult {
    const { claudeAccounts, codexAccounts, rateLimits } = this.requireServices()
    return {
      outcome,
      snapshot: {
        claude: claudeAccounts.listAccounts(),
        codex: codexAccounts.listAccounts(),
        rateLimits: rateLimits.getState()
      }
    }
  }

  private requireGrokResetLedger(): GrokResetCreditLedger {
    if (!this.grokResetLedger) {
      const store = this.getStore()
      if (!store) {
        throw new Error('Grok reset-credit persistence is unavailable')
      }
      this.grokResetLedger = new GrokResetCreditLedger(store)
    }
    return this.grokResetLedger
  }

  removeClaude(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.removeAccount(accountId)
  }

  addClaudeFromConfigDir(
    configDir: string,
    options?: {
      runtime?: 'host' | 'wsl'
      wslDistro?: string | null
      previousLegacyCredentialsSha256?: string | null
    }
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.requireServices().claudeAccounts.addAccountFromConfigDir(configDir, options)
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
    return services.rateLimits.onStateChange((rateLimits) => {
      listener({
        claude: services.claudeAccounts.listAccounts(),
        codex: services.codexAccounts.listAccounts(),
        rateLimits
      })
    })
  }

  private requireServices(): RuntimeAccountServices {
    if (!this.services) {
      throw new Error('Account services are not configured on this runtime')
    }
    return this.services
  }
}
