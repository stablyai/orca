import { RateLimitServiceFetchTargets } from './service-fetch-targets'
import { withoutResetWindows } from './service-result-policy'
import {
  LIVE_CLAUDE_INGEST_DEDUPE_MS,
  MIN_REFETCH_MS,
  normalizeClaudeConfigDir,
  type ClaudeRuntimeAuthPreparation,
  type ActiveRateLimitProvider,
  type ClaudeStatusLineRateLimits,
  type NormalizedClaudeAccountSelectionTarget,
  type ProviderRateLimits
} from './service-types'
import {
  isSameClaudeUsageWindow,
  keepNewerClaudeUsageWindow,
  mapClaudeUsageWindow
} from '../claude-usage-window'
import { readUserClaudeConfigDir } from '../../claude-accounts/claude-profile-paths'
import { getClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'

export abstract class RateLimitServiceFetchPolicy extends RateLimitServiceFetchTargets {
  protected getMiniMaxCredentialError(message: string): ProviderRateLimits {
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

  protected getZcodePlanCredentialError(message: string): ProviderRateLimits {
    return {
      provider: 'zcode',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error',
      usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
    }
  }

  // Retry-After remains binding even when live posts restore ok display; early polls waste budget and prolong 429s.
  protected isRetryAfterActive(limits: ProviderRateLimits | null): boolean {
    return Boolean(limits?.usageMetadata?.retryAtMs && limits.usageMetadata.retryAtMs > Date.now())
  }

  // A live receipt preserves display, not proof of selected-account freshness.
  protected isLiveClaudeUsageFresh(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'ok' &&
      limits.usageMetadata?.source === 'live-session' &&
      Date.now() - limits.updatedAt < MIN_REFETCH_MS
    )
  }

  // Claude's Retry-After and agy's sign-in hold bind automated checks; user refreshes may pass.
  protected shouldSkipAutomatedFetch(
    provider: ActiveRateLimitProvider,
    limits: ProviderRateLimits | null
  ): boolean {
    return (provider === 'claude' || provider === 'antigravity') && this.isRetryAfterActive(limits)
  }

  protected resolveClaudeFetchApply(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | null
  ): ProviderRateLimits {
    this.lastClaudeCheckCompletedAt = fresh.updatedAt
    // Failed OAuth must preserve newer live display while forwarding Retry-After to the poll gate.
    const current = this.state.claude
    if (fresh.status !== 'ok' && current && this.isLiveClaudeUsageFresh(current)) {
      const retryAtMs = fresh.usageMetadata?.retryAtMs
      return retryAtMs
        ? { ...current, usageMetadata: { ...current.usageMetadata, retryAtMs } }
        : current
    }
    return this.applyStalePolicy(fresh, previous)
  }

  protected rememberClaudeAuthSnapshot(
    authPreparation: ClaudeRuntimeAuthPreparation | undefined,
    claudeGeneration: number,
    claudeTarget: NormalizedClaudeAccountSelectionTarget
  ): void {
    // A switch during resolver await invalidates attribution; never restore the outgoing configDir.
    if (
      claudeGeneration !== this.claudeFetchGeneration ||
      !this.isSameClaudeTarget(claudeTarget, this.claudeFetchTarget)
    ) {
      return
    }
    const nextSnapshot = {
      // System Default uses the user config folder without injecting a managed one.
      configDir: normalizeClaudeConfigDir(
        authPreparation?.envPatch.CLAUDE_CONFIG_DIR ??
          getClaudeProfileRouter()?.userConfigDir() ??
          readUserClaudeConfigDir(process.env)
      ),
      provenance: authPreparation?.provenance ?? 'system'
    }
    // A changed folder or provenance means the bearer may have rotated.
    this.lastClaudeAuthSnapshot = nextSnapshot
  }

  ingestLiveClaudeRateLimits(event: ClaudeStatusLineRateLimits): void {
    // Why first: a session of another managed account reports that account's own quota; keeping it
    // gives auto-switch a fresh reading between polls.
    // A pane whose billed account differs from its spawn folder names that account on the event.
    const inactive = this.inactiveClaudeAccountsResolver?.() ?? []
    const billed = event.billingAccountId
    if (billed && inactive.some((account) => account.id === billed)) {
      this.ingestLiveInactiveClaudeRateLimits(billed, event)
      return
    }
    const eventConfigDir = normalizeClaudeConfigDir(event.configDir)
    let liveAccountId: string | null = null
    if (!billed && eventConfigDir) {
      try {
        liveAccountId = this.liveClaudeAccountResolver?.(eventConfigDir) ?? null
      } catch (error) {
        // Why swallow: the resolver is wired from outside; its failure must never stop the selected account's own feed.
        console.debug('[rate-limits] live account resolver threw', { eventConfigDir, error })
      }
    }
    if (liveAccountId && inactive.some((account) => account.id === liveAccountId)) {
      this.ingestLiveInactiveClaudeRateLimits(liveAccountId, event)
      return
    }
    // Why: attribution needs the selected account's config dir; until a fetch cycle captures it, drop posts rather than guess the account.
    // A billed post already names its account, so a missing or mismatched spawn folder does not drop it.
    const snapshot = this.lastClaudeAuthSnapshot
    if (!billed) {
      if (!snapshot) {
        console.debug('[rate-limits] dropped live Claude usage: no auth snapshot yet', {
          eventConfigDir: event.configDir
        })
        return
      }
      // Different accounts/runtimes report their own quota; never merge them into this bar.
      if (normalizeClaudeConfigDir(event.configDir) !== snapshot.configDir) {
        console.debug('[rate-limits] dropped live Claude usage: configDir mismatch', {
          eventConfigDir: event.configDir,
          snapshotConfigDir: snapshot.configDir
        })
        return
      }
    }
    const previous = this.state.claude
    const now = Date.now()
    const incomingSession = mapClaudeUsageWindow(event.fiveHour ?? undefined, 300)
    const incomingWeekly = mapClaudeUsageWindow(event.sevenDay ?? undefined, 10080)
    const freshSession = keepNewerClaudeUsageWindow(incomingSession, previous?.session, now)
    const freshWeekly = keepNewerClaudeUsageWindow(incomingWeekly, previous?.weekly, now)
    if (!freshSession && !freshWeekly) {
      return
    }
    // Kept snapshots can outlive a reset; never relabel a past-reset window as live.
    const inherited = previous ? withoutResetWindows(previous, now) : null
    // Partial statusline payloads leave unreported windows unchanged.
    const session = freshSession ?? inherited?.session ?? null
    const weekly = freshWeekly ?? inherited?.weekly ?? null
    // Stale posts that repeat the surviving window must not refresh live-feed age.
    const droppedStale = (incomingSession && !freshSession) || (incomingWeekly && !freshWeekly)
    if (
      droppedStale &&
      isSameClaudeUsageWindow(previous?.session ?? null, session) &&
      isSameClaudeUsageWindow(previous?.weekly ?? null, weekly)
    ) {
      return
    }
    if (
      previous?.status === 'ok' &&
      previous.usageMetadata?.source === 'live-session' &&
      now - previous.updatedAt < LIVE_CLAUDE_INGEST_DEDUPE_MS &&
      isSameClaudeUsageWindow(previous.session, session) &&
      isSameClaudeUsageWindow(previous.weekly, weekly)
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
        // Statusline lacks Fable scope and credits; retain the latest OAuth values.
        fableWeekly: inherited?.fableWeekly ?? null,
        extraUsage: inherited?.extraUsage ?? null,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        usageMetadata: {
          source: 'live-session',
          lastSuccessfulSource: 'live-session',
          credentialSource: previous?.usageMetadata?.credentialSource,
          retryAtMs: previous?.usageMetadata?.retryAtMs,
          authProvenance: snapshot?.provenance ?? (billed ? `profile:${billed}` : 'system')
        }
      }
    })
  }

  // Why its own entry and not the bar: the selected account's bar must never show another account's quota.
  protected ingestLiveInactiveClaudeRateLimits(
    accountId: string,
    event: ClaudeStatusLineRateLimits
  ): void {
    const previous = this.inactiveClaudeCache.get(accountId) ?? null
    const now = Date.now()
    const incomingSession = mapClaudeUsageWindow(event.fiveHour ?? undefined, 300)
    const incomingWeekly = mapClaudeUsageWindow(event.sevenDay ?? undefined, 10080)
    const freshSession = keepNewerClaudeUsageWindow(incomingSession, previous?.session, now)
    const freshWeekly = keepNewerClaudeUsageWindow(incomingWeekly, previous?.weekly, now)
    if (!freshSession && !freshWeekly) {
      return
    }
    // Kept snapshots can outlive a reset; never relabel a past-reset window as live.
    const inherited = previous ? withoutResetWindows(previous, now) : null
    // Partial statusline payloads leave unreported windows unchanged.
    const session = freshSession ?? inherited?.session ?? null
    const weekly = freshWeekly ?? inherited?.weekly ?? null
    // Stale posts that repeat the surviving window must not refresh live-feed age.
    const droppedStale = (incomingSession && !freshSession) || (incomingWeekly && !freshWeekly)
    if (
      droppedStale &&
      isSameClaudeUsageWindow(previous?.session ?? null, session) &&
      isSameClaudeUsageWindow(previous?.weekly ?? null, weekly)
    ) {
      return
    }
    if (
      previous?.status === 'ok' &&
      previous.usageMetadata?.source === 'live-session' &&
      Date.now() - previous.updatedAt < LIVE_CLAUDE_INGEST_DEDUPE_MS &&
      isSameClaudeUsageWindow(previous.session, session) &&
      isSameClaudeUsageWindow(previous.weekly, weekly)
    ) {
      return
    }
    this.inactiveClaudeCache.set(accountId, {
      provider: 'claude',
      session,
      weekly,
      fableWeekly: inherited?.fableWeekly ?? null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        source: 'live-session',
        lastSuccessfulSource: 'live-session',
        credentialSource: previous?.usageMetadata?.credentialSource,
        retryAtMs: previous?.usageMetadata?.retryAtMs,
        authProvenance: `profile:${accountId}`
      }
    })
    this.pushToRenderer()
  }
}
