import { beforeEach, describe, expect, it } from 'vitest'
import {
  AMBIGUOUS_REFRESH_REPLAY_DELAY_MS,
  blocksAmbiguousRefreshReplay,
  forgetAmbiguousRefreshAttempt,
  recordAmbiguousRefreshAttempt
} from './profile-cloud-refresh-replay-guard'

describe('ambiguous cloud refresh replay guard', () => {
  beforeEach(() => {
    forgetAmbiguousRefreshAttempt('profile')
  })

  it('releases expired attempts before the next replay check', () => {
    recordAmbiguousRefreshAttempt('profile', 'token', 1_000)

    expect(blocksAmbiguousRefreshReplay('profile', 'token', 1_000)).toBe(true)
    expect(
      blocksAmbiguousRefreshReplay('profile', 'token', 1_000 + AMBIGUOUS_REFRESH_REPLAY_DELAY_MS)
    ).toBe(false)
    expect(blocksAmbiguousRefreshReplay('profile', 'token', 1_000)).toBe(false)
  })

  it('keeps the newest bounded working set under key churn', () => {
    for (let index = 0; index < 600; index += 1) {
      recordAmbiguousRefreshAttempt(`profile-${index}`, 'token', 1_000 + index)
    }

    expect(blocksAmbiguousRefreshReplay('profile-0', 'token', 1_000)).toBe(false)
    expect(blocksAmbiguousRefreshReplay('profile-599', 'token', 1_599)).toBe(true)
  })
})
