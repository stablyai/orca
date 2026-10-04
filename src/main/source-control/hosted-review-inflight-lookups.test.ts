import { afterEach, expect, it, vi } from 'vitest'
import {
  __resetHostedReviewInflightLookupsForTests,
  expireOverdueInflight,
  getInflightLookup,
  releaseInflight,
  retireInflightWithPrefix,
  trackInflight
} from './hosted-review-inflight-lookups'
import { HOSTED_REVIEW_LOOKUP_DEADLINE_MS } from './hosted-review-refresh-pacing'

afterEach(__resetHostedReviewInflightLookupsForTests)

it.each(['completion', 'deadline'])(
  'releases a retired owner on %s while preserving its successor',
  (outcome) => {
    const oldToken = {}
    const oldExpire = vi.fn(() => releaseInflight('repo\0branch', oldToken))
    trackInflight('repo\0branch', {
      token: oldToken,
      startedAt: 0,
      promise: Promise.resolve(null),
      expire: oldExpire
    })
    retireInflightWithPrefix('repo\0')
    const replacement = {
      token: {},
      startedAt: HOSTED_REVIEW_LOOKUP_DEADLINE_MS,
      promise: Promise.resolve(null),
      expire: vi.fn()
    }
    trackInflight('repo\0branch', replacement)
    if (outcome === 'completion') {
      expect(releaseInflight('repo\0branch', oldToken)).toBe(false)
    }
    expireOverdueInflight(HOSTED_REVIEW_LOOKUP_DEADLINE_MS)
    expect(oldExpire).toHaveBeenCalledTimes(outcome === 'deadline' ? 1 : 0)
    expect(replacement.expire).not.toHaveBeenCalled()
    expect(getInflightLookup('repo\0branch')).toBe(replacement)
    expireOverdueInflight(HOSTED_REVIEW_LOOKUP_DEADLINE_MS + 1)
    expect(oldExpire).toHaveBeenCalledTimes(outcome === 'deadline' ? 1 : 0)
    expect(releaseInflight('repo\0branch', replacement.token)).toBe(true)
  }
)
