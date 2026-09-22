import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_NO_NATIVE_SOURCE_REASON,
  buildAntigravityNativeUnavailable,
  fetchAntigravityRateLimits
} from './antigravity-native-usage-source'

describe('antigravity native usage source', () => {
  it('reports Antigravity-native unavailability rather than any other provider quota', async () => {
    const antigravity = await fetchAntigravityRateLimits()

    expect(antigravity.provider).toBe('antigravity')
    expect(antigravity.status).toBe('unavailable')
    expect(antigravity.error).toBe(ANTIGRAVITY_NO_NATIVE_SOURCE_REASON)
    expect(antigravity.session).toBeNull()
    expect(antigravity.weekly).toBeNull()
    expect(antigravity.buckets).toBeUndefined()
  })

  it('never blames Gemini for an Antigravity unavailability', async () => {
    const antigravity = await fetchAntigravityRateLimits()

    expect(antigravity.error).not.toMatch(/gemini/i)
    expect(antigravity.error).not.toMatch(/code assist/i)
  })

  it('takes no account or host input, so two accounts cannot share state', async () => {
    // Why: the source reads nothing account-scoped; identical output is the isolation proof
    // until a native per-account probe exists.
    const first = buildAntigravityNativeUnavailable(1_700_000_000_000)
    const second = buildAntigravityNativeUnavailable(1_700_000_000_000)

    expect(first).toEqual(second)
    expect(fetchAntigravityRateLimits.length).toBe(0)
  })

  it('stamps the snapshot so activation freshness checks can age it out', () => {
    expect(buildAntigravityNativeUnavailable(1_700_000_000_000).updatedAt).toBe(1_700_000_000_000)
  })
})
