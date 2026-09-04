import { describe, expect, it } from 'vitest'
import { deriveZaiAuthConfigured } from './zai-auth-configured'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

function zai(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('deriveZaiAuthConfigured', () => {
  it('is false before any Z.AI fetch has settled', () => {
    expect(deriveZaiAuthConfigured(null)).toBe(false)
  })

  it('is true for a settled quota answer', () => {
    expect(deriveZaiAuthConfigured(zai({ status: 'ok' }))).toBe(true)
  })

  it('is false for the explicit missing-credentials answer', () => {
    expect(
      deriveZaiAuthConfigured(
        zai({
          status: 'unavailable',
          usageMetadata: { failureKind: 'missing-credentials' }
        })
      )
    ).toBe(false)
  })

  it('stays true through transient errors so the bar does not drop', () => {
    expect(deriveZaiAuthConfigured(zai({ status: 'error', error: 'network' }))).toBe(true)
  })

  it('is false for an unavailable answer without credential evidence', () => {
    expect(deriveZaiAuthConfigured(zai({ status: 'unavailable' }))).toBe(false)
  })
})
