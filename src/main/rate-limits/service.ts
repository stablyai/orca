/* eslint-disable max-lines -- Why: this service centralizes polling, stale-data
handling, account-switch fetch semantics, and renderer push coordination so the
fetch ordering rules stay in one place. */
import type { BrowserWindow } from 'electron'
import type {
  RateLimitState,
  ProviderRateLimits,
  InactiveAccountUsage
} from '../../shared/rate-limit-types'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import type { InactiveClaudeAccountInfo } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'

export type InactiveCodexAccountInfo = {
  id: string
  managedHomePath: string
}

// Why: quota state does not need near-real-time polling, and a less aggressive
// default reduces avoidable Claude /usage pressure. We intentionally use a
// slower cadence here rather than polling every 2 minutes.
const DEFAULT_POLL_MS = 5 * 60 * 1000 // 5 minutes
const MIN_REFETCH_MS = 30 * 1000 // 30 seconds — debounce rapid refresh requests
const STALE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes — after this, stale data is dropped
const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000 // 60 seconds — debounce fetch-on-open

// Why: the internal state only tracks claude and codex. The inactiveClaudeAccounts
// array is derived from the cache on demand in getState() and pushToRenderer().
type InternalRateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
}

export class RateLimitService {
  private state: InternalRateLimitState = { claude: null, codex: null, gemini: null, opencodeGo: null }
  private pollInterval: number = DEFAULT_POLL_MS
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFetchAt = 0
  private mainWindow: BrowserWindow | null = null
  private detachWindowListeners: (() => void) | null = null
  private isFetching = false
  private fullFetchQueued = false
  private codexOnlyFetchQueued = false
  private claudeOnlyFetchQueued = false
  private fetchIdleResolvers: (() => void)[] = []
  private codexFetchGeneration = 0
  private claudeFetchGeneration = 0
  private opencodeFetchGeneration = 0
  private lastOpencodeConfigHash = ''
  private codexHomePathResolver: (() => string | null) | null = null
  private claudeAuthPreparationResolver: (() => Promise<ClaudeRuntimeAuthPreparation>) | null = null
  private settingsResolver:
    | (() => {
        opencodeSessionCookie: string
        opencodeWorkspaceId: string
        geminiCliOAuthEnabled?: boolean
      })
    | null = null
  private inactiveClaudeAccountsResolver: (() => InactiveClaudeAccountInfo[]) | null = null
  private inactiveCodexAccountsResolver: (() => InactiveCodexAccountInfo[]) | null = null
  private inactiveClaudeCache = new Map<string, ProviderRateLimits>()
  private inactiveCodexCache = new Map<string, ProviderRateLimits>()
  private inactiveClaudeFetching = new Set<string>()
  private inactiveCodexFetching = new Set<string>()
  private lastInactiveClaudeFetchAt = 0
  private lastInactiveCodexFetchAt = 0

  constructor() {}

  setCodexHomePathResolver(resolver: () => string | null): void {
    this.codexHomePathResolver = resolver
  }

  setClaudeAuthPreparationResolver(resolver: () => Promise<ClaudeRuntimeAuthPreparation>): void {
    this.claudeAuthPreparationResolver = resolver
  }

  setSettingsResolver(
    resolver: () => {
      opencodeSessionCookie: string
      opencodeWorkspaceId: string
      geminiCliOAuthEnabled?: boolean
    }
  ): void {
    this.settingsResolver = resolver
  }

  setInactiveClaudeAccountsResolver(resolver: () => InactiveClaudeAccountInfo[]): void {
    this.inactiveClaudeAccountsResolver = resolver
  }

  setInactiveCodexAccountsResolver(resolver: () => InactiveCodexAccountInfo[]): void {
    this.inactiveCodexAccountsResolver = resolver
  }

  attach(mainWindow: BrowserWindow): void {
    this.detachWindowListeners?.()
    this.mainWindow = mainWindow
    const refreshOnResume = (): void => {
      void this.refreshIfWindowActive()
    }
    mainWindow.on('focus', refreshOnResume)
    mainWindow.on('show', refreshOnResume)
    mainWindow.on('restore', refreshOnResume)
    this.detachWindowListeners = () => {
      mainWindow.removeListener('focus', refreshOnResume)
      mainWindow.removeListener('show', refreshOnResume)
      mainWindow.removeListener('restore', refreshOnResume)
    }
    mainWindow.on('closed', () => {
      this.detachWindowListeners?.()
      this.detachWindowListeners = null
      if (this.mainWindow === mainWindow) {
        this.mainWindow = null
      }
    })
  }

  start(): void {
    // Fire initial fetch immediately on start
    void this.fetchAll()
    this.startTimer()
  }

  stop(): void {
    this.stopTimer()
    this.detachWindowListeners?.()
    this.detachWindowListeners = null
    this.mainWindow = null
  }

  getState(): RateLimitState {
    return {
      ...this.state,
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
    // Why: the explicit refresh button is a user-directed recovery action.
    // Debouncing it behind the background poll throttle makes the UI feel
    // broken after wake/focus transitions because the click can no-op even
    // though the user is asking for a fresh read right now.
    await this.fetchAll({ force: true })
    return this.getState()
  }

  async refreshForCodexAccountChange(outgoingAccountId?: string | null): Promise<RateLimitState> {
    if (outgoingAccountId && this.state.codex?.session) {
      this.inactiveCodexCache.set(outgoingAccountId, this.state.codex)
    }
    this.codexFetchGeneration += 1
    this.lastInactiveCodexFetchAt = 0
    // Why: switching the selected Codex account must immediately clear the old
    // Codex quota view. Keeping stale values visible would show the previous
    // account's limits under the newly selected identity until the next poll.
    this.updateState({
      ...this.state,
      codex: this.withFetchingStatus(null, 'codex')
    })
    await this.fetchCodexOnly({ force: true })
    return this.getState()
  }

  async refreshForClaudeAccountChange(outgoingAccountId?: string | null): Promise<RateLimitState> {
    // Why: snapshot the outgoing account's usage before clearing it so the
    // inline usage bars in the switcher can show last-known data immediately.
    if (outgoingAccountId && this.state.claude?.session) {
      this.inactiveClaudeCache.set(outgoingAccountId, this.state.claude)
    }
    this.claudeFetchGeneration += 1
    this.lastInactiveClaudeFetchAt = 0
    this.updateState({
      ...this.state,
      claude: this.withFetchingStatus(null, 'claude')
    })
    await this.fetchClaudeOnly({ force: true })
    return this.getState()
  }

  async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
    if (Date.now() - this.lastInactiveClaudeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    const accounts = this.inactiveClaudeAccountsResolver?.() ?? []
    if (accounts.length === 0) {
      return
    }

    for (const account of accounts) {
      this.inactiveClaudeFetching.add(account.id)
    }
    this.pushToRenderer()

    for (const account of accounts) {
      try {
        const fresh = await fetchManagedAccountUsage(account)
        const cached = this.inactiveClaudeCache.get(account.id) ?? null
        this.inactiveClaudeCache.set(account.id, this.applyStalePolicy(fresh, cached))
      } catch {
        // Why: per-account try/catch prevents one Keychain rejection or
        // network error from aborting the remaining accounts in the batch.
      }
      this.inactiveClaudeFetching.delete(account.id)
      this.pushToRenderer()
    }

    this.lastInactiveClaudeFetchAt = Date.now()
  }

  async fetchInactiveCodexAccountsOnOpen(): Promise<void> {
    if (Date.now() - this.lastInactiveCodexFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) {
      return
    }
    const accounts = this.inactiveCodexAccountsResolver?.() ?? []
    if (accounts.length === 0) {
      return
    }

    for (const account of accounts) {
      this.inactiveCodexFetching.add(account.id)
    }
    this.pushToRenderer()

    for (const account of accounts) {
      try {
        // Why: fetchCodexRateLimits already accepts codexHomePath, so we can
        // point it at the managed account's home directory directly without
        // materializing credentials into the shared runtime location.
        const fresh = await fetchCodexRateLimits({ codexHomePath: account.managedHomePath })
        const cached = this.inactiveCodexCache.get(account.id) ?? null
        this.inactiveCodexCache.set(account.id, this.applyStalePolicy(fresh, cached))
      } catch {
        // Why: per-account try/catch prevents one failure from aborting the batch.
      }
      this.inactiveCodexFetching.delete(account.id)
      this.pushToRenderer()
    }

    this.lastInactiveCodexFetchAt = Date.now()
  }

  evictInactiveClaudeCache(accountId: string): void {
    this.inactiveClaudeCache.delete(accountId)
    this.inactiveClaudeFetching.delete(accountId)
    this.pushToRenderer()
  }

  evictInactiveCodexCache(accountId: string): void {
    this.inactiveCodexCache.delete(accountId)
    this.inactiveCodexFetching.delete(accountId)
    this.pushToRenderer()
  }

  setPollingInterval(ms: number): void {
    this.pollInterval = Math.max(30_000, ms)
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

  private shouldBackgroundPoll(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false
    }
    // Why: these quota fetches only power in-app UI. When Orca is hidden,
    // minimized, or unfocused, polling only burns CLI/API budget without any
    // visible benefit. We refresh again as soon as the window becomes active.
    if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
      return false
    }
    return this.mainWindow.isFocused()
  }

  private async refreshIfWindowActive(): Promise<void> {
    if (!this.shouldBackgroundPoll()) {
      return
    }
    if (Date.now() - this.lastFetchAt < MIN_REFETCH_MS) {
      return
    }
    await this.fetchAll()
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
      while (shouldContinue) {
        await this.runFetchAllCycle()
        shouldContinue = false
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          shouldContinue = true
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          await this.runFetchCodexOnlyCycle()
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          await this.runFetchClaudeOnlyCycle()
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
        await this.runFetchCodexOnlyCycle()
        shouldContinue = false
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          await this.runFetchAllCycle()
          continue
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          await this.runFetchClaudeOnlyCycle()
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
      while (shouldContinue) {
        await this.runFetchClaudeOnlyCycle()
        shouldContinue = false
        if (this.fullFetchQueued) {
          this.fullFetchQueued = false
          await this.runFetchAllCycle()
          continue
        }
        if (this.claudeOnlyFetchQueued) {
          this.claudeOnlyFetchQueued = false
          shouldContinue = true
        }
        if (this.codexOnlyFetchQueued) {
          this.codexOnlyFetchQueued = false
          await this.runFetchCodexOnlyCycle()
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
      !this.claudeOnlyFetchQueued
    ) {
      return Promise.resolve()
    }
    // Why: explicit refresh callers need to await the queued follow-up cycle
    // when a poll is already in flight, otherwise the UI stops spinning before
    // the user-requested refresh actually runs.
    return new Promise((resolve) => {
      this.fetchIdleResolvers.push(resolve)
    })
  }

  private resolveFetchIdleWaiters(): void {
    if (
      this.isFetching ||
      this.fullFetchQueued ||
      this.codexOnlyFetchQueued ||
      this.claudeOnlyFetchQueued
    ) {
      return
    }
    const resolvers = this.fetchIdleResolvers
    this.fetchIdleResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  private withFetchingStatus(
    current: ProviderRateLimits | null,
    provider: 'claude' | 'codex' | 'gemini' | 'opencode-go'
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
    return { ...current, status: 'fetching' }
  }

  private async runFetchAllCycle(): Promise<void> {
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.()
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const claudeGeneration = this.claudeFetchGeneration
    const codexHomePath = this.codexHomePathResolver?.() ?? null
    const codexProvenance = codexHomePath ? `managed:${codexHomePath}` : 'system'
    const codexGeneration = this.codexFetchGeneration
    const previousState = this.state
    const settings = this.settingsResolver?.()
    const cookie = settings?.opencodeSessionCookie ?? ''
    const workspaceIdOverride = settings?.opencodeWorkspaceId ?? ''
    const geminiCliOAuthEnabled = settings?.geminiCliOAuthEnabled ?? false

    // Detect if configuration changed — if it did, we must discard any stale
    // data because it belongs to a different session/workspace.
    const currentConfigHash = `${cookie}|${workspaceIdOverride}`
    const opencodeConfigChanged = currentConfigHash !== this.lastOpencodeConfigHash
    if (opencodeConfigChanged) {
      this.lastOpencodeConfigHash = currentConfigHash
      this.opencodeFetchGeneration += 1
    }
    const opencodeGeneration = this.opencodeFetchGeneration

    // Mark all providers as fetching while keeping previous data visible.
    // Codex account changes clear Codex separately before this method is
    // called, so ordinary refreshes still preserve the current values.
    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude'),
      codex: this.withFetchingStatus(previousState.codex, 'codex'),
      gemini: this.withFetchingStatus(previousState.gemini, 'gemini'),
      opencodeGo: opencodeConfigChanged
        ? this.withFetchingStatus(null, 'opencode-go')
        : this.withFetchingStatus(previousState.opencodeGo, 'opencode-go')
    })

    const [claudeResult, codexResult, geminiResult, opencodeGoResult] = await Promise.allSettled([
      fetchClaudeRateLimits({ authPreparation: claudeAuthPreparation }),
      fetchCodexRateLimits({ codexHomePath }),
      fetchGeminiRateLimits(geminiCliOAuthEnabled),
      fetchOpenCodeGoRateLimits(cookie, workspaceIdOverride || undefined)
    ])

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

    const latestCodexHomePath = this.codexHomePathResolver?.() ?? null
    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.()
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const latestCodexProvenance = latestCodexHomePath ? `managed:${latestCodexHomePath}` : 'system'
    const shouldApplyCodex =
      codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance
    const shouldApplyClaude =
      claudeGeneration === this.claudeFetchGeneration && claudeProvenance === latestClaudeProvenance
    const shouldApplyOpencode = opencodeGeneration === this.opencodeFetchGeneration

    // Why: account switches can race in-flight Codex fetches. Only apply a
    // Codex result if both the selected-account provenance and the request
    // generation still match, otherwise an old account could overwrite the
    // newly selected account's quota state.
    this.updateState({
      ...previousState,
      claude: shouldApplyClaude
        ? this.applyStalePolicy(claude, previousState.claude)
        : this.state.claude,
      codex: shouldApplyCodex
        ? this.applyStalePolicy(codex, previousState.codex)
        : this.state.codex,
      gemini: this.applyStalePolicy(gemini, previousState.gemini),
      opencodeGo: shouldApplyOpencode
        ? opencodeConfigChanged
          ? opencodeGo
          : this.applyStalePolicy(opencodeGo, previousState.opencodeGo)
        : this.state.opencodeGo
    })

    this.lastFetchAt = Date.now()
  }

  private async runFetchCodexOnlyCycle(): Promise<void> {
    const codexHomePath = this.codexHomePathResolver?.() ?? null
    const codexProvenance = codexHomePath ? `managed:${codexHomePath}` : 'system'
    const codexGeneration = this.codexFetchGeneration
    const previousState = this.state

    this.updateState({
      ...previousState,
      codex: this.withFetchingStatus(previousState.codex, 'codex')
    })

    const codex = await fetchCodexRateLimits({ codexHomePath }).catch(
      (err): ProviderRateLimits => ({
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        status: 'error'
      })
    )

    const latestCodexHomePath = this.codexHomePathResolver?.() ?? null
    const latestCodexProvenance = latestCodexHomePath ? `managed:${latestCodexHomePath}` : 'system'
    const shouldApplyCodex =
      codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance

    this.updateState({
      ...this.state,
      codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
    })

    this.lastFetchAt = Date.now()
  }

  private async runFetchClaudeOnlyCycle(): Promise<void> {
    const claudeAuthPreparation = await this.claudeAuthPreparationResolver?.()
    const claudeProvenance = claudeAuthPreparation?.provenance ?? 'system'
    const claudeGeneration = this.claudeFetchGeneration
    const previousState = this.state

    this.updateState({
      ...previousState,
      claude: this.withFetchingStatus(previousState.claude, 'claude')
    })

    const claude = await fetchClaudeRateLimits({ authPreparation: claudeAuthPreparation }).catch(
      (err): ProviderRateLimits => ({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        status: 'error'
      })
    )

    const latestClaudeAuthPreparation = await this.claudeAuthPreparationResolver?.()
    const latestClaudeProvenance = latestClaudeAuthPreparation?.provenance ?? 'system'
    const shouldApplyClaude =
      claudeGeneration === this.claudeFetchGeneration && claudeProvenance === latestClaudeProvenance

    this.updateState({
      ...this.state,
      claude: shouldApplyClaude
        ? this.applyStalePolicy(claude, previousState.claude)
        : this.state.claude
    })

    this.lastFetchAt = Date.now()
  }

  private applyStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    // Fresh data is fine — use it
    if (fresh.status === 'ok') {
      return fresh
    }

    // Explicitly unavailable — user likely cleared a setting. Discard any stale
    // data so the UI reflects that the provider is now disabled/unconfigured.
    if (fresh.status === 'unavailable') {
      return fresh
    }

    const previousHasData = Boolean(
      previous?.session ||
      previous?.weekly ||
      previous?.monthly ||
      (previous?.buckets && previous.buckets.length > 0)
    )

    // No previous data to fall back on
    if (!previous || !previousHasData) {
      return fresh
    }

    // Previous data is too old — don't show stale data
    if (Date.now() - previous.updatedAt > STALE_THRESHOLD_MS) {
      return fresh
    }

    // Why: once we have a recent successful snapshot, repeated transient
    // failures should keep showing that same snapshot until it ages out of the
    // stale window. Otherwise the bar flaps from "stale but useful" to empty
    // after the second failure even though the last known quota is still fresh
    // enough to be actionable.
    return {
      ...previous,
      error: fresh.error,
      status: 'error'
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
        claude: limits,
        updatedAt: limits.updatedAt,
        isFetching: fetching.has(accountId)
      })
    }
    // Why: include accounts that are fetching but have no cache yet so the
    // renderer can show a loading indicator for newly added accounts.
    for (const accountId of fetching) {
      if (!cache.has(accountId)) {
        result.push({
          accountId,
          claude: null,
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }
    this.mainWindow.webContents.send('rateLimits:update', this.getState())
  }
}
