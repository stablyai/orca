import { RateLimitServiceFetchTargets } from './service-fetch-targets'
import {
  LIVE_CLAUDE_INGEST_DEDUPE_MS,
  MIN_REFETCH_MS,
  isSameUsageWindow,
  normalizeClaudeConfigDir,
  type ClaudeRuntimeAuthPreparation,
  type ClaudeStatusLineRateLimits,
  type NormalizedClaudeAccountSelectionTarget,
  type ProviderRateLimits
} from './service-types'
import { mapClaudeUsageWindow } from '../claude-usage-window'

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

  // Why: hitting a usage endpoint before its Retry-After expires burns the budget for nothing and keeps the 429 window alive.
  protected isRetryAfterActive(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'error' &&
      limits.usageMetadata?.retryAtMs &&
      limits.usageMetadata.retryAtMs > Date.now()
    )
  }

  // Why: a live Claude session already streams fresh usage windows; spending the OAuth usage endpoint's tight budget on the same data invites 429s.
  protected isLiveClaudeUsageFresh(limits: ProviderRateLimits | null): boolean {
    return Boolean(
      limits?.status === 'ok' &&
      limits.usageMetadata?.source === 'live-session' &&
      Date.now() - limits.updatedAt < MIN_REFETCH_MS
    )
  }

  protected shouldSkipAutomatedClaudeFetch(limits: ProviderRateLimits | null): boolean {
    return this.isRetryAfterActive(limits) || this.isLiveClaudeUsageFresh(limits)
  }

  protected resolveClaudeFetchApply(
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

  protected rememberClaudeAuthSnapshot(
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
}
