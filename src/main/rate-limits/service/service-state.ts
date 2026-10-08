import type { BrowserWindow } from 'electron'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/rate-limit-types'
import {
  type ActiveRateLimitProvider,
  type InactiveCodexAccountInfo,
  type InternalRateLimitState,
  type CodexHomePathResolver,
  type KimiHomeResolver,
  type ClaudeAuthPreparationResolver,
  type OpenCodeGoRateLimitConfig,
  type MiniMaxRateLimitConfig,
  type AntigravityUsageEnabledResolver,
  type ZcodePlanRateLimitConfig,
  type GeminiCliOAuthEnabledResolver,
  type NormalizedCodexAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget,
  type InactiveClaudeAccountInfo,
  type NetworkProxySettings,
  DEFAULT_POLL_MS
} from './service-types'
import type { AccountDiscoveryPolicyResolver } from './account-discovery-policy'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/runtime-selection'

export abstract class RateLimitServiceState {
  protected state: InternalRateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    cursor: null,
    zcode: null
  }
  protected grokAuthConfigured = false
  // Why: the Cursor probe reads the macOS Keychain, so it cannot run synchronously
  // at construction the way Grok's auth-file probe does; each fetch cycle sets it.
  protected cursorAuthConfigured = false
  protected openCodeGoApiKeyConfigured = false
  protected pollInterval: number = DEFAULT_POLL_MS
  protected timer: ReturnType<typeof setInterval> | null = null
  protected deferredStartupRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // Why: throttle repeated focus/show/restore events so one outage doesn't create a tight provider retry loop.
  protected lastActiveFailureRetryAtByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0,
    cursor: 0,
    zcode: 0
  }
  // Why: consecutive failures drive exponential backoff of the fast activation-retry lane; reset on any success/unavailable result.
  protected activeFailureStreakByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0,
    cursor: 0,
    zcode: 0
  }
  protected mainWindow: BrowserWindow | null = null
  protected detachWindowListeners: (() => void) | null = null
  protected isFetching = false
  protected fullFetchQueued = false
  protected codexOnlyFetchQueued = false
  protected claudeOnlyFetchQueued = false
  protected grokOnlyFetchQueued = false
  protected activeFetchAbortControllers = new Set<AbortController>()
  protected fetchIdleResolvers: (() => void)[] = []
  protected codexFetchGeneration = 0
  protected claudeFetchGeneration = 0
  // Why: statusline ingest must attribute live windows to the selected account without re-running the side-effectful auth sync per post.
  protected lastClaudeAuthSnapshot: { configDir: string | null; provenance: string } | null = null
  protected opencodeFetchGeneration = 0
  protected minimaxFetchGeneration = 0
  protected zcodeFetchGeneration = 0
  protected lastOpencodeConfigHash = ''
  protected lastMiniMaxConfigHash = ''
  protected lastZcodeConfigHash = ''
  protected codexHomePathResolver: CodexHomePathResolver | null = null
  protected codexFetchTarget: NormalizedCodexAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  // Why: resolved per cycle — the local-account runtime policy can flip between fetches.
  protected kimiHomeResolver: KimiHomeResolver | null = null
  protected claudeAuthPreparationResolver: ClaudeAuthPreparationResolver | null = null
  protected claudeFetchTarget: NormalizedClaudeAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  protected openCodeGoConfigResolver: (() => OpenCodeGoRateLimitConfig) | null = null
  protected openCodeGoApiKeyResolver: (() => string | null) | null = null
  protected miniMaxConfigResolver: (() => MiniMaxRateLimitConfig) | null = null
  protected zcodePlanConfigResolver: (() => ZcodePlanRateLimitConfig) | null = null
  protected geminiCliOAuthEnabledResolver: GeminiCliOAuthEnabledResolver | null = null
  protected antigravityUsageEnabledResolver: AntigravityUsageEnabledResolver | null = null
  protected inactiveClaudeAccountsResolver: (() => InactiveClaudeAccountInfo[]) | null = null
  protected inactiveCodexAccountsResolver: (() => InactiveCodexAccountInfo[]) | null = null
  protected networkProxySettingsResolver: (() => NetworkProxySettings) | null = null
  protected inactiveClaudeCache = new Map<string, ProviderRateLimits>()
  protected inactiveCodexCache = new Map<string, ProviderRateLimits>()
  protected inactiveClaudeFetching = new Set<string>()
  protected inactiveCodexFetching = new Set<string>()
  protected inactiveCodexFetchInFlight = false
  protected lastInactiveClaudeFetchAt = 0
  protected inactiveClaudeAccountsGeneration = 0
  protected lastInactiveCodexFetchAt = 0
  protected inactiveCodexAccountsGeneration = 0
  protected stateListeners = new Set<(state: RateLimitState) => void>()

  private accountDiscoveryPolicyResolver: AccountDiscoveryPolicyResolver | null = null

  setAccountDiscoveryPolicyResolver(resolver: AccountDiscoveryPolicyResolver): void {
    this.accountDiscoveryPolicyResolver = resolver
    this.accountDiscoveryPolicyChanged()
  }

  accountDiscoveryPolicyChanged(): void {
    for (const controller of this.activeFetchAbortControllers) {
      controller.abort()
    }
    this.claudeFetchGeneration += 1
    this.codexFetchGeneration += 1
    this.opencodeFetchGeneration += 1
    this.minimaxFetchGeneration += 1
    this.zcodeFetchGeneration += 1
    this.lastClaudeAuthSnapshot = null
    if (!this.isProviderAllowed('grok')) {
      this.grokAuthConfigured = false
    }
    if (!this.isProviderAllowed('cursor')) {
      this.cursorAuthConfigured = false
    }
    if (!this.isProviderAllowed('opencode-go')) {
      this.openCodeGoApiKeyConfigured = false
    }
    this.updateState(this.state)
  }

  protected isAutomaticDiscoveryEnabled(): boolean {
    return this.accountDiscoveryPolicyResolver?.().automaticallyDetect ?? true
  }

  protected isProviderAllowed(
    provider: ProviderRateLimits['provider'],
    target?: ClaudeAccountSelectionTarget
  ): boolean {
    const policy = this.accountDiscoveryPolicyResolver?.()
    const effectiveTarget =
      target ?? (provider === 'claude' ? this.claudeFetchTarget : this.codexFetchTarget)
    return !policy || policy.automaticallyDetect || policy.isConnected(provider, effectiveTarget)
  }

  onStateChange(listener: (state: RateLimitState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  protected abstract getState(): RateLimitState

  protected buildInactiveArray(
    cache: Map<string, ProviderRateLimits>,
    fetching: Set<string>
  ): InactiveAccountUsage[] {
    const result: InactiveAccountUsage[] = []
    for (const [accountId, limits] of cache) {
      result.push({
        accountId,
        rateLimits: limits,
        updatedAt: limits.updatedAt,
        isFetching: fetching.has(accountId)
      })
    }
    // Why: include fetching-but-uncached accounts so the renderer shows a loading indicator for newly added accounts.
    for (const accountId of fetching) {
      if (!cache.has(accountId)) {
        result.push({
          accountId,
          rateLimits: null,
          updatedAt: 0,
          isFetching: true
        })
      }
    }
    return result
  }

  protected projectAllowedState(next: InternalRateLimitState): InternalRateLimitState {
    return {
      claude: this.isProviderAllowed('claude') ? next.claude : null,
      codex: this.isProviderAllowed('codex') ? next.codex : null,
      gemini: this.isProviderAllowed('gemini') ? next.gemini : null,
      opencodeGo: this.isProviderAllowed('opencode-go') ? next.opencodeGo : null,
      kimi: this.isProviderAllowed('kimi') ? next.kimi : null,
      antigravity: this.isProviderAllowed('antigravity') ? next.antigravity : null,
      minimax: this.isProviderAllowed('minimax') ? next.minimax : null,
      grok: this.isProviderAllowed('grok') ? next.grok : null,
      cursor: this.isProviderAllowed('cursor') ? next.cursor : null,
      zcode: this.isProviderAllowed('zcode') ? next.zcode : null
    }
  }

  protected updateState(next: InternalRateLimitState): void {
    this.state = this.projectAllowedState(next)
    this.pushToRenderer()
  }

  protected pushToRenderer(): void {
    const state = this.getState()
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // ignore — one bad listener must not break the others
      }
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }
    this.mainWindow.webContents.send('rateLimits:update', state)
  }
}
