/* eslint-disable max-lines -- Why: centralizes polling, stale-data handling, account-switch fetch semantics, and renderer push coordination in one place */
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  CodexRateLimitResetResult,
  RateLimitState,
  ProviderRateLimits,
  InactiveAccountUsage
} from '../../shared/rate-limit-types'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import type { InactiveClaudeAccountInfo } from './claude-fetcher'
import { mapClaudeUsageWindow } from './claude-usage-window'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import {
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget,
  type NormalizedClaudeAccountSelectionTarget
} from '../claude-accounts/runtime-selection'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { hasMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import {
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget,
  type NormalizedCodexAccountSelectionTarget
} from '../codex-accounts/runtime-selection'

export type InactiveCodexAccountInfo = {
  id: string
  managedHomePath: string
}

type CodexHomePathResolver = (target?: CodexAccountSelectionTarget) => string | null
type ClaudeAuthPreparationResolver = (
  target?: ClaudeAccountSelectionTarget
) => Promise<ClaudeRuntimeAuthPreparation>

type OpenCodeGoRateLimitConfig = {
  sessionCookie: string
  workspaceIdOverride: string
}

type MiniMaxRateLimitConfig = {
  sessionCookie: string
  groupId: string
  models: string
}

type MiniMaxResolvedConfig = {
  config: MiniMaxRateLimitConfig
  error: string | null
}

type GeminiCliOAuthEnabledResolver = () => boolean
type ActiveRateLimitProvider = ProviderRateLimits['provider']
type ActiveProviderState = {
  provider: ActiveRateLimitProvider
  limits: ProviderRateLimits | null
}
type ActiveWindowRefreshPlan =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'providers'; providers: ActiveRateLimitProvider[] }

// Why: Claude's usage endpoint has a tight budget and quota is only informational; prefer a recent snapshot over polling into 429s.
const DEFAULT_POLL_MS = 15 * 60 * 1000 // 15 minutes
const MIN_POLL_MS = 30 * 1000 // 30 seconds — renderer input should never create a tight loop.
const MAX_POLL_MS = 2_147_483_647 // Max safe setInterval delay before Node clamps back to 1ms.
const MIN_REFETCH_MS = 5 * 60 * 1000 // 5 minutes — debounce resume/manual refresh bursts
const ACTIVE_FAILURE_REFETCH_MS = MIN_POLL_MS
// Why: retrying a persistent failure at the 30s floor hammers endpoints into 429s; back off per failure, capped at the poll cadence.
const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS
const MAX_ACTIVE_FAILURE_STREAK = 8
// Why: these providers have a dedicated fetch cycle, so an activation retry refreshes just the failing one; others force a full fetchAll.
const INDIVIDUALLY_REFRESHABLE_PROVIDERS: ReadonlySet<ActiveRateLimitProvider> = new Set([
  'claude',
  'codex',
  'grok'
])
const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes — after this, stale data is dropped
// Why: usage-endpoint 429 windows can outlast the generic threshold (Retry-After ~1h); quota is informational, so a stale snapshot beats a bare "Limited".
const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
// Why: statusline posts arrive on every turn; skip renderer pushes for identical windows so streaming sessions don't spam state updates.
const LIVE_CLAUDE_INGEST_DEDUPE_MS = 30 * 1000
const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000 // 60 seconds — debounce fetch-on-open
const DEFERRED_STARTUP_ACTIVE_REFRESH_MS = 1000

// Why: inactive account arrays are derived from provider caches on demand in getState()/pushToRenderer().
type InternalRateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
}

function normalizePollingInterval(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_POLL_MS
  }
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms))
}

function isSystemDefaultClaudeAuth(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined
): boolean {
  // Why: fetch cycles treat missing Claude auth as system-default; align the PTY gate so refresh can't trigger auth flows.
  if (!authPreparation) {
    return true
  }
  const provenance = authPreparation?.provenance
  return provenance === 'system' || Boolean(provenance?.endsWith(':system'))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeClaudeConfigDir(dir: string | null | undefined): string | null {
  // Why: the same dir can arrive with mixed separators (Windows env vs statusline JSON); unify them so attribution compares paths, not spellings. Case is left alone — Linux paths are case-sensitive.
  const trimmed = dir?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed || null
}

function isSameUsageWindow(
  a: ProviderRateLimits['session'],
  b: ProviderRateLimits['session']
): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt
}

export class RateLimitService {
  private state: InternalRateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null
  }
  private grokAuthConfigured = readGrokAuthSession().status === 'ok'
  private pollInterval: number = DEFAULT_POLL_MS
  private timer: ReturnType<typeof setInterval> | null = null
  private deferredStartupRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // Why: throttle repeated focus/show/restore events so one outage doesn't create a tight provider retry loop.
  private lastActiveFailureRetryAtByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0
  }
  // Why: consecutive failures drive exponential backoff of the fast activation-retry lane; reset on any success/unavailable result.
  private activeFailureStreakByProvider: Record<ActiveRateLimitProvider, number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    'opencode-go': 0,
    kimi: 0,
    minimax: 0,
    grok: 0,
    antigravity: 0
  }
  private mainWindow: BrowserWindow | null = null
  private detachWindowListeners: (() => void) | null = null
  private isFetching = false
  private fullFetchQueued = false
  private codexOnlyFetchQueued = false
  private claudeOnlyFetchQueued = false
  private grokOnlyFetchQueued = false
  private activeFetchAbortControllers = new Set<AbortController>()
  private fetchIdleResolvers: (() => void)[] = []
  private codexFetchGeneration = 0
  private claudeFetchGeneration = 0
  // Why: statusline ingest must attribute live windows to the selected account without re-running the side-effectful auth sync per post.
  private lastClaudeAuthSnapshot: { configDir: string | null; provenance: string } | null = null
  private opencodeFetchGeneration = 0
  private minimaxFetchGeneration = 0
  private lastOpencodeConfigHash = ''
  private lastMiniMaxConfigHash = ''
  private codexHomePathResolver: CodexHomePathResolver | null = null
  private codexFetchTarget: NormalizedCodexAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  private claudeAuthPreparationResolver: ClaudeAuthPreparationResolver | null = null
  private claudeFetchTarget: NormalizedClaudeAccountSelectionTarget = {
    runtime: 'host',
    wslDistro: null
  }
  private openCodeGoConfigResolver: (() => OpenCodeGoRateLimitConfig) | null = null
  private miniMaxConfigResolver: (() => MiniMaxRateLimitConfig) | null = null
  private geminiCliOAuthEnabledResolver: GeminiCliOAuthEnabledResolver | null = null
  private inactiveClaudeAccountsResolver: (() => InactiveClaudeAccountInfo[]) | null = null
  private inactiveCodexAccountsResolver: (() => InactiveCodexAccountInfo[]) | null = null
  private networkProxySettingsResolver: (() => NetworkProxySettings) | null = null
  private inactiveClaudeCache = new Map<string, ProviderRateLimits>()
  private inactiveCodexCache = new Map<string, ProviderRateLimits>()
  private inactiveClaudeFetching = new Set<string>()
  private inactiveCodexFetching = new Set<string>()
  private lastInactiveClaudeFetchAt = 0
  private inactiveClaudeAccountsGeneration = 0
  private lastInactiveCodexFetchAt = 0
  private inactiveCodexAccountsGeneration = 0
  private stateListeners = new Set<(state: RateLimitState) => void>()

  constructor() {}

  onStateChange(listener: (state: RateLimitState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  setCodexHomePathResolver(resolver: CodexHomePathResolver): void {
    this.codexHomePathResolver = resolver
  }

  setCodexFetchTarget(target?: CodexAccountSelectionTarget): void {
    this.codexFetchTarget = normalizeCodexAccountSelectionTarget(target)
  }

  setClaudeAuthPreparationResolver(resolver: ClaudeAuthPreparationResolver): void {
    this.claudeAuthPreparationResolver = resolver
  }

  setClaudeFetchTarget(target?: ClaudeAccountSelectionTarget): void {
    this.claudeFetchTarget = normalizeClaudeAccountSelectionTarget(target)
  }

  setOpenCodeGoConfigResolver(resolver: () => OpenCodeGoRateLimitConfig): void {
    this.openCodeGoConfigResolver = resolver
  }

  setMiniMaxConfigResolver(resolver: () => MiniMaxRateLimitConfig): void {
    this.miniMaxConfigResolver = resolver
  }

  setGeminiCliOAuthEnabledResolver(resolver: GeminiCliOAuthEnabledResolver): void {
    this.geminiCliOAuthEnabledResolver = resolver
  }

  setNetworkProxySettingsResolver(resolver: () => NetworkProxySettings): void {
    this.networkProxySettingsResolver = resolver
  }

  setInactiveClaudeAccountsResolver(resolver: () => InactiveClaudeAccountInfo[]): void {
    this.inactiveClaudeAccountsResolver = resolver
    this.inactiveClaudeAccountsGeneration += 1
  }

  setInactiveCodexAccountsResolver(resolver: () => InactiveCodexAccountInfo[]): void {
    this.inactiveCodexAccountsResolver = resolver
    this.inactiveCodexAccountsGeneration += 1
    this.pruneInactiveCodexState()
  }

  attach(mainWindow: BrowserWindow): void {
    this.detachWindowListeners?.()
    this.mainWindow = mainWindow
    const refreshOnResume = (): void => {
      void this.refreshIfWindowActive()
    }
    // Why: attach() can replace windows; remove the previous closed listener too, not only the focus listeners.
    const detachWindowListeners = (): void => {
      mainWindow.removeListener('focus', refreshOnResume)
      mainWindow.removeListener('show', refreshOnResume)
      mainWindow.removeListener('restore', refreshOnResume)
      mainWindow.removeListener('closed', onClosed)
    }
    const onClosed = (): void => {
      detachWindowListeners()
      if (this.detachWindowListeners === detachWindowListeners) {
        this.detachWindowListeners = null
      }
      if (this.mainWindow === mainWindow) {
        this.mainWindow = null
      }
    }
    mainWindow.on('focus', refreshOnResume)
    mainWindow.on('show', refreshOnResume)
    mainWindow.on('restore', refreshOnResume)
    mainWindow.on('closed', onClosed)
    this.detachWindowListeners = detachWindowListeners
  }

  start(options: { fetchImmediately?: boolean } = {}): void {
    if (options.fetchImmediately !== false) {
      void this.fetchAll()
    } else {
      this.scheduleDeferredStartupRefresh()
    }
    this.startTimer()
  }

  stop(): void {
    this.abortActiveFetchCycle()
    this.clearQueuedFetches()
    this.inactiveClaudeFetching.clear()
    this.inactiveCodexFetching.clear()
    this.resolveAndClearFetchIdleWaiters()
    this.stopTimer()
    this.clearDeferredStartupRefresh()
    this.detachWindowListeners?.()
    this.detachWindowListeners = null
    this.mainWindow = null
  }

  getState(): RateLimitState {
    this.pruneInactiveClaudeState()
    this.pruneInactiveCodexState()
    return {
      ...this.state,
      // Why: the cookie lives on the filesystem, not GlobalSettings; surface its presence so the renderer keeps the MiniMax bar across reloads.
      minimaxCookieConfigured: hasMiniMaxSessionCookie(),
      grokAuthConfigured: this.grokAuthConfigured,
      claudeTarget: this.claudeFetchTarget,
      codexTarget: this.codexFetchTarget,
      inactiveClaudeAccounts: this.buildInactiveArray(
        this.inactiveClaudeCache,
        this.inactiveClaudeFetching
      ),
      inactiveCodexAccounts: this.buildInactiveArray(
        this.inactiveCodexCache,
        this.inactiveCodexFetching
      )
    }
  }

  async refresh(): Promise<RateLimitState> {
    // Why: this user-directed refresh must bypass the poll throttle, else the click can no-op after wake/focus and feel broken.
    await this.fetchAll({ force: true })
    return this.getState()
  }

  async refreshIfStale(): Promise<RateLimitState> {
    // Why: reconnecting mobile subscribers need fresh backgrounded-desktop data, but replaying a subscription must not queue another forced fetch.
    const plan = this.getActiveWindowRefreshPlan(Date.now())
    await this.runActiveWindowRefreshPlan(plan)
    return this.getState()
  }

  async refreshGrok(): Promise<RateLimitState> {
    await this.fetchGrokOnly({ force: true })
    return this.getState()
  }

  invalidateMiniMaxCredentialState(): void {
    this.minimaxFetchGeneration += 1
    // Why: saving/forgetting the cookie can race an in-flight fetch; clear the visible snapshot before any old-cookie result returns.
    this.updateState({
      ...this.state,
      minimax: this.withFetchingStatus(null, 'minimax')
    })
  }

  async refreshForCodexAccountChange(
    outgoingAccountId?: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<RateLimitState> {
    const nextTarget = normalizeCodexAccountSelectionTarget(target)
    if (
      outgoingAccountId &&
      this.state.codex?.session &&
      this.isSameCodexTarget(this.codexFetchTarget, nextTarget)
    ) {
      this.inactiveCodexCache.set(outgoingAccountId, this.state.codex)
    }
    this.codexFetchTarget = nextTarget
    this.codexFetchGeneration += 1
    // Why: a new account/target starts with a clean retry schedule.
    this.activeFailureStreakByProvider.codex = 0
    this.inactiveCodexAccountsGeneration += 1
    this.pruneInactiveCodexState()
    this.lastInactiveCodexFetchAt = 0
    // Why: clear the old Codex view immediately, else the previous account's limits show under the newly selected identity until the next poll.
    this.updateState({
      ...this.state,
      codex: this.withFetchingStatus(null, 'codex')
    })
    await this.fetchCodexOnly({ force: true })
    return this.getState()
  }

  async refreshCodexForTarget(target?: CodexAccountSelectionTarget): Promise<RateLimitState> {
    const nextTarget = normalizeCodexAccountSelectionTarget(target)
    const targetChanged = !this.isSameCodexTarget(this.codexFetchTarget, nextTarget)
    this.codexFetchTarget = nextTarget
    this.codexFetchGeneration += 1
    this.activeFailureStreakByProvider.codex = 0
    this.updateState({
      ...this.state,
      codex: this.withFetchingStatus(targetChanged ? null : this.state.codex, 'codex')
    })
    await this.fetchCodexOnly({ force: true })
    return this.getState()
  }

  async consumeCodexRateLimitResetCredit(): Promise<CodexRateLimitResetResult> {
    const codexTarget = this.codexFetchTarget
    const codexHomePath = this.codexHomePathResolver?.(codexTarget) ?? null
    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    if (missingWslCodexHome) {
      await this.fetchCodexOnly({ force: true })
      throw new Error(missingWslCodexHome.error ?? 'Codex home unavailable')
    }
    try {
      const outcome = await consumeCodexRateLimitResetCredit({
        codexHomePath,
        idempotencyKey: randomUUID()
      })
      await this.fetchCodexOnly({ force: true })
      return { outcome, state: this.getState() }
    } catch (error) {
      await this.fetchCodexOnly({ force: true })
      throw error
    }
  }

  async refreshForClaudeAccountChange(
    outgoingAccountId?: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<RateLimitState> {
    const nextTarget = normalizeClaudeAccountSelectionTarget(target)
    // Why: snapshot the outgoing account's usage before clearing so the switcher's inline bars can show last-known data immediately.
    if (
      outgoingAccountId &&
      this.state.claude?.session &&
      this.isSameClaudeTarget(this.claudeFetchTarget, nextTarget)
    ) {
      this.inactiveClaudeCache.set(outgoingAccountId, this.state.claude)
    }
    this.claudeFetchTarget = nextTarget
    this.inactiveClaudeAccountsGeneration += 1
    this.pruneInactiveClaudeState()
    this.claudeFetchGeneration += 1
    // Why: a new account/target starts with a clean retry schedule.
    this.activeFailureStreakByProvider.claude = 0
    // Why: statusline posts from the outgoing account's sessions must not land on the incoming account's bar mid-switch.
    this.lastClaudeAuthSnapshot = null
    this.lastInactiveClaudeFetchAt = 0
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(null, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }

  async refreshClaudeForTarget(target?: ClaudeAccountSelectionTarget): Promise<RateLimitState> {
    const nextTarget = normalizeClaudeAccountSelectionTarget(target)
    const targetChanged = !this.isSameClaudeTarget(this.claudeFetchTarget, nextTarget)
    this.claudeFetchTarget = nextTarget
    this.claudeFetchGeneration += 1
    this.activeFailureStreakByProvider.claude = 0
    if (targetChanged) {
      // Why: statusline posts from the outgoing target's sessions must not land on the incoming target's bar mid-switch.
      this.lastClaudeAuthSnapshot = null
    }
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(targetChanged ? null : this.state.claude, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }

  async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
    if (Date.now() - this.lastInactiveClaudeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    this.pruneInactiveClaudeState()
    if (this.inactiveClaudeFetching.size > 0) {
      return
    }
    const accounts = this.inactiveClaudeAccountsResolver?.() ?? []
    if (accounts.length === 0) {
      return
    }
    const fetchGeneration = this.inactiveClaudeAccountsGeneration
    const controller = this.beginFetchCycle()
    const signal = controller.signal

    for (const account of accounts) {
      this.inactiveClaudeFetching.add(account.id)
    }
    this.pushToRenderer()

    try {
      for (const account of accounts) {
        if (
          signal.aborted ||
          fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
          !this.isCurrentInactiveClaudeAccount(account.id)
        ) {
          this.inactiveClaudeFetching.delete(account.id)
          if (!this.isCurrentInactiveClaudeAccount(account.id)) {
            this.inactiveClaudeCache.delete(account.id)
          }
          this.pushToRenderer()
          continue
        }
        try {
          const fresh = await fetchManagedAccountUsage(account, {
            allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
            networkProxySettings: this.networkProxySettingsResolver?.(),
            signal
          })
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            this.inactiveClaudeFetching.delete(account.id)
            if (!this.isCurrentInactiveClaudeAccount(account.id)) {
              this.inactiveClaudeCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          const cached = this.inactiveClaudeCache.get(account.id) ?? null
          this.inactiveClaudeCache.set(account.id, this.applyStalePolicy(fresh, cached))
        } catch {
          // Why: per-account try/catch keeps one Keychain/network error from aborting the remaining accounts in the batch.
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveClaudeAccountsGeneration ||
            !this.isCurrentInactiveClaudeAccount(account.id)
          ) {
            this.inactiveClaudeCache.delete(account.id)
          }
        }
        this.inactiveClaudeFetching.delete(account.id)
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.inactiveClaudeAccountsGeneration) {
        this.lastInactiveClaudeFetchAt = Date.now()
      }
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  async fetchInactiveCodexAccountsOnOpen(): Promise<void> {
    if (Date.now() - this.lastInactiveCodexFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    this.pruneInactiveCodexState()
    if (this.inactiveCodexFetching.size > 0) {
      return
    }
    const accounts = this.inactiveCodexAccountsResolver?.() ?? []
    if (accounts.length === 0) {
      return
    }
    // Why: account switching can activate a previewed account while its RPC-only fetch is still in flight; ignore stale results.
    const fetchGeneration = this.inactiveCodexAccountsGeneration
    const controller = this.beginFetchCycle()
    const signal = controller.signal

    for (const account of accounts) {
      this.inactiveCodexFetching.add(account.id)
    }
    this.pushToRenderer()

    try {
      for (const account of accounts) {
        if (
          signal.aborted ||
          fetchGeneration !== this.inactiveCodexAccountsGeneration ||
          !this.isCurrentInactiveCodexAccount(account.id)
        ) {
          this.inactiveCodexFetching.delete(account.id)
          if (!this.isCurrentInactiveCodexAccount(account.id)) {
            this.inactiveCodexCache.delete(account.id)
          }
          this.pushToRenderer()
          continue
        }
        try {
          // Why: point fetchCodexRateLimits at the managed home directly, avoiding materializing credentials into the shared runtime location.
          // Why: no PTY fallback — the switcher preview shouldn't spawn hidden PTYs per account (can crash ConPTY on Windows); RPC-only is enough.
          const fresh = await fetchCodexRateLimits({
            codexHomePath: account.managedHomePath,
            allowPtyFallback: false,
            signal
          })
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveCodexAccountsGeneration ||
            !this.isCurrentInactiveCodexAccount(account.id)
          ) {
            this.inactiveCodexFetching.delete(account.id)
            if (!this.isCurrentInactiveCodexAccount(account.id)) {
              this.inactiveCodexCache.delete(account.id)
            }
            this.pushToRenderer()
            continue
          }
          const cached = this.inactiveCodexCache.get(account.id) ?? null
          this.inactiveCodexCache.set(account.id, this.applyStalePolicy(fresh, cached))
        } catch {
          // Why: per-account try/catch prevents one failure from aborting the batch.
          if (
            signal.aborted ||
            fetchGeneration !== this.inactiveCodexAccountsGeneration ||
            !this.isCurrentInactiveCodexAccount(account.id)
          ) {
            this.inactiveCodexCache.delete(account.id)
          }
        }
        this.inactiveCodexFetching.delete(account.id)
        this.pushToRenderer()
      }

      if (!signal.aborted && fetchGeneration === this.inactiveCodexAccountsGeneration) {
        this.lastInactiveCodexFetchAt = Date.now()
      }
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  evictInactiveClaudeCache(accountId: string): void {
    this.inactiveClaudeAccountsGeneration += 1
    this.inactiveClaudeCache.delete(accountId)
    this.inactiveClaudeFetching.delete(accountId)
    this.pushToRenderer()
  }

  private isCurrentInactiveClaudeAccount(accountId: string): boolean {
    return (this.inactiveClaudeAccountsResolver?.() ?? []).some(
      (account) => account.id === accountId
    )
  }

  private isCurrentInactiveCodexAccount(accountId: string): boolean {
    return (this.inactiveCodexAccountsResolver?.() ?? []).some(
      (account) => account.id === accountId
    )
  }

  private pruneInactiveClaudeState(): void {
    const currentIds = new Set(
      (this.inactiveClaudeAccountsResolver?.() ?? []).map((account) => account.id)
    )
    for (const accountId of this.inactiveClaudeCache.keys()) {
      if (!currentIds.has(accountId)) {
        this.inactiveClaudeCache.delete(accountId)
      }
    }
    for (const accountId of this.inactiveClaudeFetching) {
      if (!currentIds.has(accountId)) {
        this.inactiveClaudeFetching.delete(accountId)
      }
    }
  }

  private pruneInactiveCodexState(): void {
    const currentIds = new Set(
      (this.inactiveCodexAccountsResolver?.() ?? []).map((account) => account.id)
    )
    for (const accountId of this.inactiveCodexCache.keys()) {
      if (!currentIds.has(accountId)) {
        this.inactiveCodexCache.delete(accountId)
      }
    }
    for (const accountId of this.inactiveCodexFetching) {
      if (!currentIds.has(accountId)) {
        this.inactiveCodexFetching.delete(accountId)
      }
    }
  }

  evictInactiveCodexCache(accountId: string): void {
    // Why: clear only this account, not the generation — bumping it would discard sibling fetches still in flight and their fresh results.
    this.inactiveCodexCache.delete(accountId)
    this.inactiveCodexFetching.delete(accountId)
    this.pushToRenderer()
  }

  setPollingInterval(ms: number): void {
    this.pollInterval = normalizePollingInterval(ms)
    if (this.timer) {
      this.stopTimer()
      this.startTimer()
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      if (!this.shouldBackgroundPoll()) {
        return
      }
      void this.fetchAll()
    }, this.pollInterval)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private scheduleDeferredStartupRefresh(): void {
    this.clearDeferredStartupRefresh()
    this.deferredStartupRefreshTimer = setTimeout(() => {
      this.deferredStartupRefreshTimer = null
      void this.refreshIfWindowActive()
    }, DEFERRED_STARTUP_ACTIVE_REFRESH_MS)
  }

  private clearDeferredStartupRefresh(): void {
    if (this.deferredStartupRefreshTimer) {
      clearTimeout(this.deferredStartupRefreshTimer)
      this.deferredStartupRefreshTimer = null
    }
  }

  private shouldBackgroundPoll(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false
    }
    // Why: these fetches only power in-app UI; skip polling when hidden/minimized/unfocused to save CLI/API budget (refresh on activate).
    if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
      return false
    }
    return this.mainWindow.isFocused()
  }

  private getActiveProviderState(): ActiveProviderState[] {
    // Why: key by provider so a new provider is compile-forced an entry — a missing one silently never recovers from a startup error.
    const byProvider: Record<ActiveRateLimitProvider, ProviderRateLimits | null> = {
      claude: this.state.claude,
      codex: this.state.codex,
      gemini: this.state.gemini,
      'opencode-go': this.state.opencodeGo,
      kimi: this.state.kimi,
      minimax: this.state.minimax,
      grok: this.state.grok,
      antigravity: this.state.antigravity
    }
    return Object.entries(byProvider).map(([provider, limits]) => ({
      provider: provider as ActiveRateLimitProvider,
      limits
    }))
  }

  private getActiveWindowRefreshPlan(now: number): ActiveWindowRefreshPlan {
    const retryableFailures: ActiveRateLimitProvider[] = []
    for (const { provider, limits } of this.getActiveProviderState()) {
      if (!limits || limits.status === 'idle' || limits.status === 'fetching') {
        return { kind: 'full' }
      }
      if (limits.status === 'ok' || limits.status === 'unavailable') {
        if (now - limits.updatedAt >= MIN_REFETCH_MS) {
          return { kind: 'full' }
        }
        continue
      }
      // Why: a failed startup read is not fresh data; keep it eligible for activation recovery, throttled per provider.
      if (limits.status === 'error') {
        // Why: the server told us when to come back (Retry-After); retrying earlier burns the endpoint's budget and keeps the 429 alive.
        if (this.isRetryAfterActive(limits)) {
          continue
        }
        const lastRetryAt = this.lastActiveFailureRetryAtByProvider[provider]
        const throttleMs = INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)
          ? Math.min(
              ACTIVE_FAILURE_REFETCH_MS *
                2 ** Math.max(0, this.activeFailureStreakByProvider[provider] - 1),
              MAX_ACTIVE_FAILURE_REFETCH_MS
            )
          : MIN_REFETCH_MS
        if (now - lastRetryAt >= throttleMs) {
          retryableFailures.push(provider)
        }
      }
    }

    if (retryableFailures.length === 0) {
      return { kind: 'none' }
    }
    return { kind: 'providers', providers: retryableFailures }
  }

  private async runActiveWindowRefreshPlan(plan: ActiveWindowRefreshPlan): Promise<void> {
    if (plan.kind === 'none') {
      return
    }
    if (plan.kind === 'full') {
      // Why: a full fetch retries failing providers too; restart their retry clocks so the individual failure lane doesn't fire ahead of backoff.
      // Why: gated on !isFetching — the fetchAll below no-ops mid-flight, so don't consume the retry throttle for free.
      if (!this.isFetching) {
        const now = Date.now()
        for (const { provider, limits } of this.getActiveProviderState()) {
          if (limits?.status === 'error') {
            this.lastActiveFailureRetryAtByProvider[provider] = now
          }
        }
      }
      await this.fetchAll()
      return
    }

    // Why: an in-flight fetch will refresh these; skip without consuming the per-provider retry throttle so the next activation retries.
    if (this.isFetching) {
      return
    }

    const now = Date.now()
    for (const provider of plan.providers) {
      this.lastActiveFailureRetryAtByProvider[provider] = now
    }

    const canRefreshIndividually = plan.providers.every((provider) =>
      INDIVIDUALLY_REFRESHABLE_PROVIDERS.has(provider)
    )
    if (!canRefreshIndividually) {
      await this.fetchAll()
      return
    }

    // Why: recover partial failures of dedicated-fetch providers without re-reading healthy providers still inside their debounce.
    if (plan.providers.includes('claude')) {
      await this.fetchClaudeOnly()
    }
    if (plan.providers.includes('codex')) {
      await this.fetchCodexOnly()
    }
    if (plan.providers.includes('grok')) {
      await this.fetchGrokOnly()
    }
  }

  private async refreshIfWindowActive(): Promise<void> {
    if (!this.shouldBackgroundPoll()) {
      return
    }
    const plan = this.getActiveWindowRefreshPlan(Date.now())
    await this.runActiveWindowRefreshPlan(plan)
  }

  private async fetchAll(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.fullFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      // Why: only user-directed (force) fetches may bypass a provider's Retry-After gate; queued reruns inherit force because only forced calls queue them.
      let cycleForce = options?.force ?? false
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchAllCycle(fetchSignal, { force: cycleForce })
        )
        shouldContinue = false
        cycleForce = true
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          shouldContinue = true
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          const codexSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchCodexOnlyCycle(fetchSignal)
          )
          if (codexSignal.aborted) {
            break
          }
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private async fetchCodexOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.codexOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchCodexOnlyCycle(fetchSignal)
        )
        shouldContinue = false
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchAllCycle(fetchSignal, { force: true })
          )
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private async fetchClaudeOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.claudeOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      // Why: only user-directed (force) fetches may bypass a provider's Retry-After gate; queued reruns inherit force because only forced calls queue them.
      let cycleForce = options?.force ?? false
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchClaudeOnlyCycle(fetchSignal, { force: cycleForce })
        )
        shouldContinue = false
        cycleForce = true
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchAllCycle(fetchSignal, { force: true })
          )
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          const codexSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchCodexOnlyCycle(fetchSignal)
          )
          if (codexSignal.aborted) {
            break
          }
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          const grokSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchGrokOnlyCycle(fetchSignal)
          )
          if (grokSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private async fetchGrokOnly(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) {
        this.grokOnlyFetchQueued = true
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true

    try {
      let shouldContinue = true
      while (shouldContinue) {
        const signal = await this.runWithFetchAbortSignal((fetchSignal) =>
          this.runFetchGrokOnlyCycle(fetchSignal)
        )
        shouldContinue = false
        if (signal.aborted) {
          break
        }
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          const fullSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchAllCycle(fetchSignal, { force: true })
          )
          if (fullSignal.aborted) {
            break
          }
          continue
        }
        if (this.grokOnlyFetchQueued) {
          this.grokOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          const codexSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchCodexOnlyCycle(fetchSignal)
          )
          if (codexSignal.aborted) {
            break
          }
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          const claudeSignal = await this.runWithFetchAbortSignal((fetchSignal) =>
            this.runFetchClaudeOnlyCycle(fetchSignal, { force: true })
          )
          if (claudeSignal.aborted) {
            break
          }
        }
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private waitForFetchIdle(): Promise<void> {
    if (
      !this.isFetching &&
      !this.fullFetchQueued &&
      !this.codexOnlyFetchQueued &&
      !this.claudeOnlyFetchQueued &&
      !this.grokOnlyFetchQueued
    ) {
      return Promise.resolve()
    }
    // Why: explicit-refresh callers must await the queued follow-up cycle when a poll is in flight, else the UI stops spinning early.
    return new Promise((resolve) => {
      this.fetchIdleResolvers.push(resolve)
    })
  }

  private resolveFetchIdleWaiters(): void {
    if (
      this.isFetching ||
      this.fullFetchQueued ||
      this.codexOnlyFetchQueued ||
      this.claudeOnlyFetchQueued ||
      this.grokOnlyFetchQueued
    ) {
      return
    }
    const resolvers = this.fetchIdleResolvers
    this.fetchIdleResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  private beginFetchCycle(): AbortController {
    const controller = new AbortController()
    this.activeFetchAbortControllers.add(controller)
    return controller
  }

  private finishFetchCycle(controller: AbortController): void {
    this.activeFetchAbortControllers.delete(controller)
  }

  private async runWithFetchAbortSignal(
    fn: (signal: AbortSignal) => Promise<void>
  ): Promise<AbortSignal> {
    const controller = this.beginFetchCycle()
    try {
      await fn(controller.signal)
      return controller.signal
    } finally {
      this.finishFetchCycle(controller)
    }
  }

  private abortActiveFetchCycle(): void {
    for (const controller of this.activeFetchAbortControllers) {
      controller.abort()
    }
    this.activeFetchAbortControllers.clear()
  }

  private clearQueuedFetches(): void {
    this.fullFetchQueued = false
    this.codexOnlyFetchQueued = false
    this.claudeOnlyFetchQueued = false
    this.grokOnlyFetchQueued = false
  }

  private resolveAndClearFetchIdleWaiters(): void {
    const resolvers = this.fetchIdleResolvers
    this.fetchIdleResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  private isSameCodexTarget(
    left: NormalizedCodexAccountSelectionTarget,
    right: NormalizedCodexAccountSelectionTarget
  ): boolean {
    return left.runtime === right.runtime && left.wslDistro === right.wslDistro
  }

  private isSameClaudeTarget(
    left: NormalizedClaudeAccountSelectionTarget,
    right: NormalizedClaudeAccountSelectionTarget
  ): boolean {
    return left.runtime === right.runtime && left.wslDistro === right.wslDistro
  }

  private getCodexProvenance(
    target: NormalizedCodexAccountSelectionTarget,
    codexHomePath: string | null
  ): string {
    const targetKey = target.runtime === 'wsl' ? `wsl:${target.wslDistro ?? '__default__'}` : 'host'
    return codexHomePath ? `${targetKey}:managed:${codexHomePath}` : `${targetKey}:system`
  }

  private getMissingWslCodexHomeResult(
    target: NormalizedCodexAccountSelectionTarget
  ): ProviderRateLimits | null {
    if (target.runtime !== 'wsl') {
      return null
    }
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: `WSL Codex home unavailable for ${target.wslDistro ?? 'default distro'}`,
      status: 'error'
    }
  }

  private shouldAllowCodexPtyFallback(): boolean {
    // Why: hidden PTY fallback can crash inside ConPTY on Windows; prefer RPC-only degradation there for background quota refresh.
    return process.platform !== 'win32'
  }

  private shouldAllowClaudePtyFallback(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined
  ): boolean {
    // Why: Windows hidden PTY support is less reliable than host/WSL shells.
    if (process.platform === 'win32') {
      return false
    }
    // Why: system-default Claude isn't Orca-managed; refresh may read existing OAuth but must not launch Claude and trigger auth/browser flows.
    return !isSystemDefaultClaudeAuth(authPreparation)
  }

  private shouldAllowClaudeUsagePanelSupplement(): boolean {
    // Why: keep this supplement off on Windows where hidden PTYs are still less reliable.
    return process.platform !== 'win32'
  }

  private resolveMiniMaxConfig(): MiniMaxResolvedConfig {
    try {
      return {
        config: this.miniMaxConfigResolver?.() ?? {
          sessionCookie: '',
          groupId: '',
          models: 'general'
        },
        error: null
      }
    } catch (error) {
      // Why: one unreadable cookie must not abort every provider's refresh; surface it as MiniMax-only state instead.
      return {
        config: {
          sessionCookie: '',
          groupId: '',
          models: 'general'
        },
        error: toErrorMessage(error)
      }
    }
  }

  private getMiniMaxCredentialError(message: string): ProviderRateLimits {
    return {
      provider: 'minimax',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    }
  }

  // Why: hitting a usage endpoint before its Retry-After expires burns the budget for nothing and keeps the 429 window alive.
  private isRetryAfterActive(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'error' &&
      limits.usageMetadata?.retryAtMs &&
      limits.usageMetadata.retryAtMs > Date.now()
    )
  }

  // Why: a live Claude session already streams fresh usage windows; spending the OAuth usage endpoint's tight budget on the same data invites 429s.
  private isLiveClaudeUsageFresh(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'ok' &&
      limits.usageMetadata?.source === 'live-session' &&
      Date.now() - limits.updatedAt < MIN_REFETCH_MS
    )
  }

  private shouldSkipAutomatedClaudeFetch(limits: ProviderRateLimits | null): boolean {
    return this.isRetryAfterActive(limits) || this.isLiveClaudeUsageFresh(limits)
  }

  private resolveClaudeFetchApply(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    // Why: a live statusline post can land while an OAuth cycle is in flight; a failed fetch must not
    // roll the bar back to the pre-cycle snapshot or flip the just-refreshed live data to error.
    const current = this.state.claude
    if (fresh.status !== 'ok' && current && this.isLiveClaudeUsageFresh(current)) {
      return current
    }
    return this.applyStalePolicy(fresh, previous)
  }

  private rememberClaudeAuthSnapshot(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined,
    claudeGeneration: number,
    claudeTarget: NormalizedClaudeAccountSelectionTarget
  ): void {
    // Why: an account switch during the resolver await already cleared the snapshot; restoring the outgoing account's configDir here would cross-attribute its live posts to the new bar.
    if (
      claudeGeneration !== this.claudeFetchGeneration ||
      !this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    ) {
      return
    }
    this.lastClaudeAuthSnapshot = {
      configDir: normalizeClaudeConfigDir(authPreparation?.envPatch.CLAUDE_CONFIG_DIR),
      provenance: authPreparation?.provenance ?? 'system'
    }
  }

  /** Live usage windows forwarded from a Claude session's statusLine command. */
  ingestLiveClaudeRateLimits(event: ClaudeStatusLineRateLimits): void {
    // Why: attribution needs the selected account's config dir; until a fetch cycle captures it, drop posts rather than guess the account.
    const snapshot = this.lastClaudeAuthSnapshot
    if (!snapshot) {
      // Why: breadcrumbs make a silently dark live feed diagnosable — dropped posts are otherwise invisible.
      console.debug('[rate-limits] dropped live Claude usage: no auth snapshot yet', {
        eventConfigDir: event.configDir
      })
      return
    }
    // Why: sessions of other accounts (or other runtimes) report their own quota; mixing them into the active account's bar would lie.
    if (normalizeClaudeConfigDir(event.configDir) !== snapshot.configDir) {
      console.debug('[rate-limits] dropped live Claude usage: configDir mismatch', {
        eventConfigDir: event.configDir,
        snapshotConfigDir: snapshot.configDir
      })
      return
    }
    const freshSession = mapClaudeUsageWindow(event.fiveHour ?? undefined, 300)
    const freshWeekly = mapClaudeUsageWindow(event.sevenDay ?? undefined, 10080)
    if (!freshSession && !freshWeekly) {
      return
    }
    const previous = this.state.claude
    // Why: statusline payloads can carry a single window; an absent one means "no update", not "cleared" — keep the other bar populated.
    const session = freshSession ?? previous?.session ?? null
    const weekly = freshWeekly ?? previous?.weekly ?? null
    if (
      previous?.status === 'ok' &&
      previous.usageMetadata?.source === 'live-session' &&
      Date.now() - previous.updatedAt < LIVE_CLAUDE_INGEST_DEDUPE_MS &&
      isSameUsageWindow(previous.session, session) &&
      isSameUsageWindow(previous.weekly, weekly)
    ) {
      return
    }
    this.activeFailureStreakByProvider.claude = 0
    this.updateState({
      ...this.state,
      claude: {
        provider: 'claude',
        session,
        weekly,
        // Why: the statusline payload has no Fable scoped window; keep the last OAuth-provided one visible.
        // Tradeoff: while live posts keep the OAuth poll gated, fableWeekly stays frozen until the session idles past the freshness window.
        fableWeekly: previous?.fableWeekly ?? null,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        usageMetadata: {
          source: 'live-session',
          lastSuccessfulSource: 'live-session',
          credentialSource: previous?.usageMetadata?.credentialSource,
          authProvenance: snapshot.provenance
        }
      }
    })
  }

  private trackActiveFailureStreak(
    provider: ActiveRateLimitProvider,
    fresh: ProviderRateLimits
  ): void {
    if (fresh.status === 'error') {
      this.activeFailureStreakByProvider[provider] = Math.min(
        this.activeFailureStreakByProvider[provider] + 1,
        MAX_ACTIVE_FAILURE_STREAK
      )
      return
    }
    if (fresh.status === 'ok' || fresh.status === 'unavailable') {
      this.activeFailureStreakByProvider[provider] = 0
    }
  }

  private withFetchingStatus(
    current: ProviderRateLimits | null,
    provider:
      | 'claude'
      | 'codex'
      | 'gemini'
      | 'opencode-go'
      | 'kimi'
      | 'minimax'
      | 'grok'
      | 'antigravity'
  ): ProviderRateLimits {
    if (!current) {
      return {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null,
        status: 'fetching'
      }
    }
    // Why: keep a settled chip visible during background refetch so a persistently failing provider doesn't flash "…" → error each cycle.
    if (current.status === 'ok' || current.status === 'error' || current.status === 'unavailable') {
      return current
    }
    return { ...current, status: 'fetching' }
  }

  private async runFetchAllCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    if (signal.aborted) {
      return
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const codexTarget = this.codexFetchTarget
    const codexHomePath = this.codexHomePathResolver?.(codexTarget) ?? null
    const codexProvenance = this.getCodexProvenance(codexTarget, codexHomePath)
    const codexGeneration = this.codexFetchGeneration
    const previousState = this.state
    const openCodeGoConfig = this.openCodeGoConfigResolver?.()
    const cookie = openCodeGoConfig?.sessionCookie ?? ''
    const workspaceIdOverride = openCodeGoConfig?.workspaceIdOverride ?? ''
    const miniMaxConfigResult = this.resolveMiniMaxConfig()
    const miniMaxCookie = miniMaxConfigResult.config.sessionCookie
    const miniMaxGroupId = miniMaxConfigResult.config.groupId
    const miniMaxModels = miniMaxConfigResult.config.models
    const geminiCliOAuthEnabled = this.geminiCliOAuthEnabledResolver?.() ?? false
    // Why: getState() is hot (renderer pushes + mobile snapshots); keep Grok's sync auth-file probe on fetch cycles instead.
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    // Discard stale data on config change — it belongs to a different session/workspace.
    const currentConfigHash = `${cookie}|${workspaceIdOverride}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    if (opencodeConfigChanged) {
      this.lastOpencodeConfigHash = currentConfigHash
      this.opencodeFetchGeneration += 1
    }
    const opencodeGeneration = this.opencodeFetchGeneration

    const currentMiniMaxConfigHash = `${miniMaxCookie}|${miniMaxGroupId}|${miniMaxModels}|${miniMaxConfigResult.error ?? ''}`
    const miniMaxConfigChanged = currentMiniMaxConfigHash !== this.lastMiniMaxConfigHash
    if (miniMaxConfigChanged) {
      this.lastMiniMaxConfigHash = currentMiniMaxConfigHash
      this.minimaxFetchGeneration += 1
    }
    const miniMaxGeneration = this.minimaxFetchGeneration

    // Mark all providers fetching while keeping previous data visible (Codex is cleared separately on account change).
    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude'),
      codex: this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: this.withFetchingStatus(previousState.gemini, 'gemini'),
      opencodeGo: opencodeConfigChanged
        ? this.withFetchingStatus(null, 'opencode-go')
        : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go'),
      kimi: this.withFetchingStatus(previousState.kimi, 'kimi'),
      antigravity: this.withFetchingStatus(previousState.antigravity, 'antigravity'),
      minimax: miniMaxConfigChanged
        ? this.withFetchingStatus(null, 'minimax')
        : this.withFetchingStatus(previousState.minimax, 'minimax'),
      grok: this.withFetchingStatus(previousState.grok, 'grok')
    })

    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    const grokResultPromise = fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason) => ({ status: 'rejected', reason }) as const
    )

    // Why: skip automated Claude fetches while a Retry-After window is open or a live session feed is fresher than the OAuth poll would be.
    const claudeFetchGated =
      !options?.force && this.shouldSkipAutomatedClaudeFetch(previousState.claude)

    const [claudeResult, codexResult, geminiResult, opencodeGoResult, kimiResult, miniMaxResult] =
      await Promise.allSettled([
        claudeFetchGated
          ? Promise.resolve(previousState.claude as ProviderRateLimits)
          : fetchClaudeRateLimits({
              authPreparation: claudeAuthPreparation,
              allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
              allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
              networkProxySettings: this.networkProxySettingsResolver?.(),
              signal
            }),
        missingWslCodexHome ??
          fetchCodexRateLimits({
            codexHomePath,
            allowPtyFallback: this.shouldAllowCodexPtyFallback(),
            signal
          }),
        fetchGeminiRateLimits(geminiCliOAuthEnabled),
        fetchOpenCodeGoRateLimits(
          cookie,
          workspaceIdOverride || undefined,
          this.networkProxySettingsResolver?.()
        ),
        fetchKimiRateLimits(),
        miniMaxConfigResult.error
          ? Promise.resolve(this.getMiniMaxCredentialError(miniMaxConfigResult.error))
          : fetchMiniMaxRateLimits({
              cookie: miniMaxCookie,
              groupId: miniMaxGroupId,
              models: miniMaxModels
            })
      ])

    if (signal.aborted) {
      return
    }

    const claude =
      claudeResult.status === 'fulfilled'
        ? claudeResult.value
        : ({
            provider: 'claude',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              claudeResult.reason instanceof Error ? claudeResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const codex =
      codexResult.status === 'fulfilled'
        ? codexResult.value
        : ({
            provider: 'codex',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              codexResult.reason instanceof Error ? codexResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const gemini =
      geminiResult.status === 'fulfilled'
        ? geminiResult.value
        : ({
            provider: 'gemini',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              geminiResult.reason instanceof Error ? geminiResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    // Why: Antigravity shares Gemini credentials today; mirror the Gemini snapshot so its status-bar UI gets a real lifecycle instead of null.
    const antigravity: ProviderRateLimits = {
      ...gemini,
      provider: 'antigravity'
    }

    const opencodeGo =
      opencodeGoResult.status === 'fulfilled'
        ? opencodeGoResult.value
        : ({
            provider: 'opencode-go',
            session: null,
            weekly: null,
            monthly: null,
            updatedAt: Date.now(),
            error:
              opencodeGoResult.reason instanceof Error
                ? opencodeGoResult.reason.message
                : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const kimi =
      kimiResult.status === 'fulfilled'
        ? kimiResult.value
        : ({
            provider: 'kimi',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: kimiResult.reason instanceof Error ? kimiResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const miniMax =
      miniMaxResult.status === 'fulfilled'
        ? miniMaxResult.value
        : ({
            provider: 'minimax',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error:
              miniMaxResult.reason instanceof Error
                ? miniMaxResult.reason.message
                : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)

    const latestCodexHomePath = this.codexHomePathResolver?.(codexTarget) ?? null
    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const latestCodexProvenance = this.getCodexProvenance(codexTarget, latestCodexHomePath)
    const shouldApplyCodex =
      codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance
    // Why: a gated cycle made no Claude attempt; applying its passthrough result would grow the failure streak and reset stale-policy clocks for free.
    const shouldApplyClaude =
      !claudeFetchGated &&
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    const shouldApplyOpencode = opencodeGeneration === this.opencodeFetchGeneration
    const shouldApplyMiniMax = miniMaxGeneration === this.minimaxFetchGeneration

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claude)
    }
    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    this.trackActiveFailureStreak('gemini', gemini)
    this.trackActiveFailureStreak('antigravity', antigravity)
    if (shouldApplyOpencode) {
      this.trackActiveFailureStreak('opencode-go', opencodeGo)
    }
    this.trackActiveFailureStreak('kimi', kimi)
    if (shouldApplyMiniMax) {
      this.trackActiveFailureStreak('minimax', miniMax)
    }

    // Why: apply a Codex result only when provenance and generation still match, else a raced in-flight fetch overwrites the new account.
    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.resolveClaudeFetchApply(claude, previousState.claude)
        : this.state.claude,
      codex: shouldApplyCodex
        ? this.applyStalePolicy(codex, previousState.codex)
        : this.state.codex,
      gemini: this.applyStalePolicy(gemini, previousState.gemini),
      opencodeGo: shouldApplyOpencode
        ? opencodeConfigChanged
          ? opencodeGo
          : this.applyStalePolicy(opencodeGo, previousState.opencodeGo)
        : this.state.opencodeGo,
      kimi: this.applyStalePolicy(kimi, previousState.kimi),
      antigravity: this.applyStalePolicy(antigravity, previousState.antigravity),
      minimax: shouldApplyMiniMax
        ? miniMaxConfigChanged
          ? miniMax
          : this.applyStalePolicy(miniMax, previousState.minimax)
        : this.state.minimax
    })

    const grokResult = await grokResultPromise
    if (signal.aborted) {
      return
    }
    const grok =
      grokResult.status === 'fulfilled'
        ? grokResult.value
        : ({
            provider: 'grok',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: grokResult.reason instanceof Error ? grokResult.reason.message : 'Unknown error',
            status: 'error'
          } satisfies ProviderRateLimits)
    this.trackActiveFailureStreak('grok', grok)
    this.updateState({
      ...this.state,
      grok: this.applyStalePolicy(grok, previousState.grok)
    })
  }

  private async runFetchCodexOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const codexTarget = this.codexFetchTarget
    const codexHomePath = this.codexHomePathResolver?.(codexTarget) ?? null
    const codexProvenance = this.getCodexProvenance(codexTarget, codexHomePath)
    const codexGeneration = this.codexFetchGeneration
    const previousState = this.state

    this.updateState({
      ...previousState,
      codex: this.withFetchingStatus(previousState.codex, 'codex')
    })

    const missingWslCodexHome = codexHomePath
      ? null
      : this.getMissingWslCodexHomeResult(codexTarget)
    const codex = await (
      missingWslCodexHome
        ? Promise.resolve(missingWslCodexHome)
        : fetchCodexRateLimits({
            codexHomePath,
            allowPtyFallback: this.shouldAllowCodexPtyFallback(),
            signal
          })
    ).catch(
      (err): ProviderRateLimits => ({
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        status: 'error'
      })
    )

    if (signal.aborted) {
      return
    }

    const latestCodexHomePath = this.codexHomePathResolver?.(codexTarget) ?? null
    const latestCodexProvenance = this.getCodexProvenance(codexTarget, latestCodexHomePath)
    const shouldApplyCodex =
      codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance

    if (shouldApplyCodex) {
      this.trackActiveFailureStreak('codex', codex)
    }
    this.updateState({
      ...this.state,
      codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
    })
  }

  private async runFetchClaudeOnlyCycle(
    signal: AbortSignal,
    options?: { force?: boolean }
  ): Promise<void> {
    if (signal.aborted) {
      return
    }
    // Why: skip automated Claude fetches while a Retry-After window is open or a live session feed is fresher than the OAuth poll would be.
    if (!options?.force && this.shouldSkipAutomatedClaudeFetch(this.state.claude)) {
      return
    }
    const claudeTarget = this.claudeFetchTarget
    // Why: capture before the resolver await so an account switch during it invalidates both the snapshot and the state apply.
    const claudeGeneration = this.claudeFetchGeneration
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    this.rememberClaudeAuthSnapshot(claudeAuthPreparation, claudeGeneration, claudeTarget)
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const previousState = this.state

    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude')
    })

    const claude = await fetchClaudeRateLimits({
      authPreparation: claudeAuthPreparation,
      allowPtyFallback: this.shouldAllowClaudePtyFallback(claudeAuthPreparation),
      allowUsagePanelSupplement: this.shouldAllowClaudeUsagePanelSupplement(),
      networkProxySettings: this.networkProxySettingsResolver?.(),
      signal
    }).catch(
      (err): ProviderRateLimits => ({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        status: 'error'
      })
    )

    if (signal.aborted) {
      return
    }

    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.(claudeTarget)
    if (signal.aborted) {
      return
    }
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const shouldApplyClaude =
      claudeGeneration === this.claudeFetchGeneration &&
      claudeProvenance === latestClaudeProvenance &&
      this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)

    if (shouldApplyClaude) {
      this.trackActiveFailureStreak('claude', claude)
    }
    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.resolveClaudeFetchApply(claude, previousState.claude)
        : this.state.claude
    })
  }

  private async runFetchGrokOnlyCycle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return
    }
    const previousState = this.state
    const grokAuthReadResult = readGrokAuthSession()
    this.grokAuthConfigured = grokAuthReadResult.status === 'ok'

    this.updateState({
      ...previousState,
      grok: this.withFetchingStatus(previousState.grok, 'grok')
    })

    const grok = await fetchGrokRateLimits({
      signal,
      authReadResult: grokAuthReadResult
    }).catch(
      (err): ProviderRateLimits => ({
        provider: 'grok',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        status: 'error'
      })
    )

    if (signal.aborted) {
      return
    }

    this.trackActiveFailureStreak('grok', grok)
    this.updateState({
      ...this.state,
      grok: this.applyStalePolicy(grok, previousState.grok)
    })
  }

  private applyStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    // Fresh data is fine — use it
    if (fresh.status === 'ok') {
      return {
        ...fresh,
        usageMetadata: {
          ...fresh.usageMetadata,
          lastSuccessfulSource:
            fresh.usageMetadata?.source ?? fresh.usageMetadata?.lastSuccessfulSource
        }
      }
    }

    // Explicitly unavailable (e.g. setting cleared): discard stale data so the UI shows the provider as disabled/unconfigured.
    if (fresh.status === 'unavailable') {
      return fresh
    }

    const previousHasData = Boolean(
      previous?.session ||
      previous?.weekly ||
      previous?.fableWeekly ||
      previous?.monthly ||
      (previous?.buckets && previous.buckets.length > 0)
    )

    // No previous data to fall back on
    if (!previous || !previousHasData) {
      return fresh
    }

    // Previous data is too old — don't show stale data
    const staleThresholdMs =
      fresh.usageMetadata?.failureKind === 'rate-limited'
        ? RATE_LIMITED_STALE_THRESHOLD_MS
        : STALE_THRESHOLD_MS
    if (Date.now() - previous.updatedAt > staleThresholdMs) {
      return fresh
    }

    // Why: keep showing a recent snapshot through repeated transient failures until it ages out, so the bar doesn't flap to empty.
    return {
      ...previous,
      error: fresh.error,
      status: 'error',
      usageMetadata: {
        ...previous.usageMetadata,
        ...fresh.usageMetadata,
        lastSuccessfulSource:
          previous.usageMetadata?.lastSuccessfulSource ?? previous.usageMetadata?.source
      }
    }
  }

  private buildInactiveArray(
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

  private updateState(next: InternalRateLimitState): void {
    this.state = next
    this.pushToRenderer()
  }

  private pushToRenderer(): void {
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
