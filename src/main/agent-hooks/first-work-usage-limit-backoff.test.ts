import { beforeEach, describe, expect, it } from 'vitest'
import {
  noteGenerationFailureForUsageLimit,
  resetUsageLimitBackoffState,
  usageLimitBackoffRemainingMs,
  USAGE_LIMIT_DEFAULT_BACKOFF_MS,
  USAGE_LIMIT_MAX_BACKOFF_MS
} from './first-work-usage-limit-backoff'

// Fixed local-noon base so am/pm reset-time math is deterministic.
const NOW = new Date(2026, 6, 17, 12, 0, 0, 0).getTime()

describe('noteGenerationFailureForUsageLimit', () => {
  beforeEach(() => {
    resetUsageLimitBackoffState()
  })

  it('ignores unrelated generation failures', () => {
    expect(noteGenerationFailureForUsageLimit('Pi failed to start.', undefined, NOW)).toBeNull()
    expect(usageLimitBackoffRemainingMs(NOW)).toBe(0)
  })

  it('does not match our own output-size failure messages', () => {
    expect(
      noteGenerationFailureForUsageLimit(
        'Pi CLI command produced too much output. Check the agent CLI configuration and try again.',
        undefined,
        NOW
      )
    ).toBeNull()
  })

  it('arms the backoff until the stated reset time (issue #9705 message shape)', () => {
    const until = noteGenerationFailureForUsageLimit(
      'Claude exited with code 1. CLI output: hit your session limit · resets 2pm (Europe/Madrid)',
      undefined,
      NOW
    )
    expect(until).toBe(NOW + 2 * 60 * 60_000)
    expect(usageLimitBackoffRemainingMs(NOW)).toBe(2 * 60 * 60_000)
  })

  it('rolls a reset time already past today over to tomorrow', () => {
    const until = noteGenerationFailureForUsageLimit(
      '5-hour limit reached ∙ resets 10:30am',
      undefined,
      NOW
    )
    expect(until).toBe(NOW + (22 * 60 + 30) * 60_000)
  })

  it('parses the API-style epoch reset marker', () => {
    const resetAtSec = Math.floor(NOW / 1000) + 3600
    const until = noteGenerationFailureForUsageLimit(
      `Claude AI usage limit reached|${resetAtSec}`,
      undefined,
      NOW
    )
    expect(until).toBe(resetAtSec * 1000)
  })

  it('falls back to the default backoff when no reset time is stated', () => {
    const until = noteGenerationFailureForUsageLimit('usage limit reached', undefined, NOW)
    expect(until).toBe(NOW + USAGE_LIMIT_DEFAULT_BACKOFF_MS)
  })

  it('caps a far-future reset time', () => {
    const resetAtSec = Math.floor(NOW / 1000) + 3 * 24 * 3600
    const until = noteGenerationFailureForUsageLimit(
      `weekly limit reached|${resetAtSec}`,
      undefined,
      NOW
    )
    expect(until).toBe(NOW + USAGE_LIMIT_MAX_BACKOFF_MS)
  })

  it('detects the limit message in captured CLI output, not only the error string', () => {
    const until = noteGenerationFailureForUsageLimit(
      'Generated branch name was empty after sanitization.',
      {
        label: 'Claude',
        exitCode: 0,
        stdout: 'hit your usage limit · resets 3pm',
        stderr: ''
      },
      NOW
    )
    expect(until).toBe(NOW + 3 * 60 * 60_000)
  })

  it('never shortens an already-armed longer backoff', () => {
    noteGenerationFailureForUsageLimit('hit your session limit · resets 6pm', undefined, NOW)
    const until = noteGenerationFailureForUsageLimit('usage limit reached', undefined, NOW)
    expect(until).toBe(NOW + 6 * 60 * 60_000)
  })

  it('expires after the deadline', () => {
    noteGenerationFailureForUsageLimit('usage limit reached', undefined, NOW)
    expect(usageLimitBackoffRemainingMs(NOW + USAGE_LIMIT_DEFAULT_BACKOFF_MS + 1)).toBe(0)
  })

  it('treats a bare ambiguous "resets 2" as unparseable and uses the default', () => {
    const until = noteGenerationFailureForUsageLimit(
      'session limit reached, resets 2',
      undefined,
      NOW
    )
    expect(until).toBe(NOW + USAGE_LIMIT_DEFAULT_BACKOFF_MS)
  })
})
