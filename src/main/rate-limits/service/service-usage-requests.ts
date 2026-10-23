import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  composeUsageRequestPolicyEnabled,
  USAGE_REQUEST_PROVIDERS,
  type UsageRequestProvider
} from '../../../shared/usage-request-policy'
import { antigravityUsageDisabledSnapshot } from '../antigravity-usage-snapshot'
import { RateLimitServiceState } from './service-state'

type EnabledPolicy = Record<UsageRequestProvider, boolean>

export type ProviderUsageRequest = {
  provider: UsageRequestProvider
  epoch: number
  controller: AbortController
  finish: () => void
}

export abstract class RateLimitServiceUsageRequests extends RateLimitServiceState {
  private usageRequestPolicyResolver: (() => EnabledPolicy) | null = null
  private usageRequestEnabled = composeUsageRequestPolicyEnabled({}, true)
  private usageRequestRevision = 0
  private readonly usageRequestEpochs = new Map<UsageRequestProvider, number>()
  private readonly providerUsageRequests = new Set<ProviderUsageRequest>()

  setUsageRequestPolicyResolver(resolver: () => EnabledPolicy): void {
    this.usageRequestPolicyResolver = resolver
    this.reconcileUsageRequestPolicy()
  }

  reconcileUsageRequestPolicy(): void {
    const next = this.usageRequestPolicyResolver?.() ?? {
      ...this.usageRequestEnabled,
      antigravity: this.antigravityUsageEnabledResolver?.() ?? true
    }
    const changedProviders = USAGE_REQUEST_PROVIDERS.filter(
      (provider) => next[provider] !== this.usageRequestEnabled[provider]
    )
    if (changedProviders.length === 0) {
      return
    }
    this.usageRequestEnabled = { ...next }
    this.usageRequestRevision += 1
    for (const provider of changedProviders) {
      this.usageRequestEpochs.set(provider, this.providerUsageEpoch(provider) + 1)
    }
    for (const provider of changedProviders) {
      if (!next[provider]) {
        for (const request of this.providerUsageRequests) {
          if (request.provider === provider) {
            request.controller.abort()
          }
        }
        const key = provider === 'opencode-go' ? 'opencodeGo' : provider
        const current = this.state[key]
        if (provider === 'antigravity' && !current) {
          this.state = { ...this.state, antigravity: antigravityUsageDisabledSnapshot(0) }
        }
        if (current?.status === 'fetching') {
          this.state = { ...this.state, [key]: this.settledUsageSnapshot(current) }
        }
        if (provider === 'claude') {
          this.claudeOnlyFetchQueued = false
          this.inactiveClaudeFetching.clear()
        }
        if (provider === 'codex') {
          this.codexOnlyFetchQueued = false
          this.inactiveCodexFetching.clear()
        }
        if (provider === 'grok') {
          this.grokOnlyFetchQueued = false
        }
      } else {
        if (provider === 'claude') {
          this.lastInactiveClaudeFetchAt = 0
        }
        if (provider === 'codex') {
          this.lastInactiveCodexFetchAt = 0
        }
      }
    }
    this.pushToRenderer()
  }

  protected providerUsagePlaceholder(provider: UsageRequestProvider): ProviderRateLimits {
    const key = provider === 'opencode-go' ? 'opencodeGo' : provider
    return (
      this.state[key] ?? {
        provider,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null,
        status: 'unavailable'
      }
    )
  }

  protected beginAllProviderUsageRequests(
    signal: AbortSignal
  ): Record<UsageRequestProvider, ProviderUsageRequest> {
    return {
      claude: this.beginProviderUsageRequest('claude', signal),
      codex: this.beginProviderUsageRequest('codex', signal),
      gemini: this.beginProviderUsageRequest('gemini', signal),
      'opencode-go': this.beginProviderUsageRequest('opencode-go', signal),
      kimi: this.beginProviderUsageRequest('kimi', signal),
      minimax: this.beginProviderUsageRequest('minimax', signal),
      grok: this.beginProviderUsageRequest('grok', signal),
      antigravity: this.beginProviderUsageRequest('antigravity', signal),
      cursor: this.beginProviderUsageRequest('cursor', signal),
      zcode: this.beginProviderUsageRequest('zcode', signal)
    }
  }

  protected usageRequestPolicySnapshot() {
    return {
      version: 1 as const,
      revision: this.usageRequestRevision,
      enabled: { ...this.usageRequestEnabled }
    }
  }

  protected isUsageRequestEnabled(provider: UsageRequestProvider): boolean {
    this.reconcileUsageRequestPolicy()
    return this.usageRequestEnabled[provider]
  }

  protected providerUsageEpoch(provider: UsageRequestProvider): number {
    return this.usageRequestEpochs.get(provider) ?? 0
  }

  protected beginProviderUsageRequest(
    provider: UsageRequestProvider,
    parentSignal?: AbortSignal
  ): ProviderUsageRequest {
    this.reconcileUsageRequestPolicy()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const request: ProviderUsageRequest = {
      provider,
      epoch: this.providerUsageEpoch(provider),
      controller,
      finish: () => {
        parentSignal?.removeEventListener('abort', abort)
        this.providerUsageRequests.delete(request)
      }
    }
    this.providerUsageRequests.add(request)
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted || !this.isUsageRequestEnabled(provider)) {
      controller.abort()
    }
    return request
  }

  protected isProviderUsageRequestCurrent(request: ProviderUsageRequest): boolean {
    return (
      this.isUsageRequestEnabled(request.provider) &&
      !request.controller.signal.aborted &&
      request.epoch === this.providerUsageEpoch(request.provider)
    )
  }

  protected abortProviderUsageRequests(): void {
    for (const request of this.providerUsageRequests) {
      request.controller.abort()
    }
  }

  protected settledUsageSnapshot(current: ProviderRateLimits): ProviderRateLimits | null {
    if (current.status !== 'fetching') {
      return current
    }
    return current.updatedAt > 0 ? { ...current, status: current.error ? 'error' : 'ok' } : null
  }
}
