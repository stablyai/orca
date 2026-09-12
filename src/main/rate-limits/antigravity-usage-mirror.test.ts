import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'
import {
  deriveAntigravityRateLimits,
  resolveAntigravityRateLimits
} from './antigravity-usage-mirror'

function geminiSnapshot(
  status: ProviderRateLimitStatus,
  error: string | null,
  usedPercent: number | null = null
): ProviderRateLimits {
  return {
    provider: 'gemini',
    session:
      usedPercent === null
        ? null
        : { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1_700_000_000_000,
    error,
    status
  }
}

describe('deriveAntigravityRateLimits', () => {
  it('mirrors a successful Gemini read as shared Code Assist quota', () => {
    const antigravity = deriveAntigravityRateLimits(geminiSnapshot('ok', null, 42))

    expect(antigravity.provider).toBe('antigravity')
    expect(antigravity.status).toBe('ok')
    expect(antigravity.session?.usedPercent).toBe(42)
    expect(antigravity.error).toBeNull()
  })

  it('reports unavailable without quoting the Gemini failure', () => {
    const antigravity = deriveAntigravityRateLimits(
      geminiSnapshot('error', 'Gemini project ID not found')
    )

    expect(antigravity.provider).toBe('antigravity')
    expect(antigravity.status).toBe('unavailable')
    expect(antigravity.error).not.toContain('Gemini project ID not found')
    expect(antigravity.error).toContain('Antigravity usage is not available')
    expect(antigravity.session).toBeNull()
    expect(antigravity.weekly).toBeNull()
  })

  it('does not blame a missing sign-in when the quota read itself failed', () => {
    const antigravity = deriveAntigravityRateLimits(geminiSnapshot('error', 'Token refresh failed'))

    // Why: the reported symptom is a connected sign-in whose Code Assist read failed.
    expect(antigravity.error).toContain('could not be read right now')
    expect(antigravity.error).not.toContain('sign-in is connected')
  })

  it('keeps the Gemini timestamp so activation freshness checks are not forced to refetch', () => {
    const antigravity = deriveAntigravityRateLimits(geminiSnapshot('error', 'Token refresh failed'))

    expect(antigravity.updatedAt).toBe(1_700_000_000_000)
  })

  it('points at the missing sign-in when the Gemini opt-in is off', () => {
    const antigravity = deriveAntigravityRateLimits(
      geminiSnapshot('unavailable', 'Gemini CLI OAuth is disabled in settings')
    )

    expect(antigravity.status).toBe('unavailable')
    expect(antigravity.error).not.toContain('Gemini CLI OAuth is disabled in settings')
    expect(antigravity.error).toContain('Antigravity usage is not available')
    expect(antigravity.error).toContain('Gemini CLI sign-in is connected')
  })
})

describe('resolveAntigravityRateLimits', () => {
  const gemini: ProviderRateLimits = {
    provider: 'gemini',
    session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
  const direct = (
    status: ProviderRateLimits['status'],
    failureKind?: UsageRateLimitFailureKind
  ): ProviderRateLimits => ({
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: 2,
    error: status === 'ok' ? null : 'nope',
    status,
    usageMetadata: failureKind ? { source: 'oauth', failureKind } : { source: 'oauth' }
  })

  it('publishes a successful direct read over the mirror', () => {
    const ok = { ...direct('ok'), session: gemini.session }
    expect(resolveAntigravityRateLimits(ok, gemini)).toBe(ok)
  })

  it('keeps an expired sign-in visible instead of showing Gemini numbers', () => {
    const expired = direct('unavailable', 'stale-token')
    expect(resolveAntigravityRateLimits(expired, gemini)).toBe(expired)
  })

  it('keeps an unreachable host visible so absence is never implied', () => {
    const unreachable = direct('error', 'network')
    expect(resolveAntigravityRateLimits(unreachable, gemini)).toBe(unreachable)
  })

  it('falls back to the mirror when no Antigravity sign-in exists anywhere', () => {
    const result = resolveAntigravityRateLimits(
      direct('unavailable', 'missing-credentials'),
      gemini
    )
    expect(result.provider).toBe('antigravity')
    expect(result.session?.usedPercent).toBe(42)
  })

  it('falls back to the mirror for an account with no Antigravity grant', () => {
    const result = resolveAntigravityRateLimits(direct('unavailable', 'usage-unavailable'), gemini)
    expect(result.session?.usedPercent).toBe(42)
  })

  it('falls back to the mirror for a transient endpoint failure', () => {
    expect(
      resolveAntigravityRateLimits(direct('error', 'server'), gemini).session?.usedPercent
    ).toBe(42)
  })

  it('falls back to the mirror when the direct read threw', () => {
    expect(resolveAntigravityRateLimits(null, gemini).session?.usedPercent).toBe(42)
  })
})
