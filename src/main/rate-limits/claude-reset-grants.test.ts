import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mapClaudeResetGrants,
  resetClaudeResetGrantWarningsForTests,
  warnIfClaudeResetsNeedNewerCli
} from './claude-reset-grants'

const NOW = Date.parse('2026-09-22T18:00:00Z')

// Shape captured from a live `?cedar_ember=1` response, with account fields dropped.
function launchGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'opus55-launch-promax-20260921',
    label: 'Claude Opus 5.5 launch: one usage-limit reset for Pro and Max',
    resets_total: 1,
    resets_left: 1,
    starts_at: '2026-09-22T16:00:00+00:00',
    ends_at: '2026-10-22T16:00:00+00:00',
    clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 17, seven_day: 19 },
    blocking: [],
    ...overrides
  }
}

function eligibleBlock(grants: unknown[]): Record<string, unknown> {
  return {
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    exhausted: [],
    grants,
    next_grant_id: 'opus55-launch-promax-20260921',
    weekly_resets_at: '2026-09-26T18:00:00+00:00',
    cooldown_until: null
  }
}

describe('warnIfClaudeResetsNeedNewerCli', () => {
  afterEach(() => {
    resetClaudeResetGrantWarningsForTests()
    vi.restoreAllMocks()
  })

  it('warns once when the server rejects the pinned CLI version', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const block = { eligible: false, ineligible_reason: 'cli_version', grants: [] }

    warnIfClaudeResetsNeedNewerCli(block, 'claude-cli/2.1.0 (external, cli)')
    warnIfClaudeResetsNeedNewerCli(block, 'claude-cli/2.1.0 (external, cli)')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('claude-cli/2.1.0 (external, cli)')
    expect(warn.mock.calls[0]?.[0]).toContain('CLAUDE_CLI_USER_AGENT')
  })

  it('stays quiet for eligible accounts and other ineligible reasons', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnIfClaudeResetsNeedNewerCli(eligibleBlock([launchGrant()]), 'ua')
    warnIfClaudeResetsNeedNewerCli({ eligible: false, ineligible_reason: 'plan' }, 'ua')
    warnIfClaudeResetsNeedNewerCli(undefined, 'ua')

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('mapClaudeResetGrants', () => {
  it('maps an eligible grant to an available reset with its expiry', () => {
    expect(mapClaudeResetGrants(eligibleBlock([launchGrant()]), NOW)).toEqual({
      availableCount: 1,
      totalEarnedCount: 1,
      nextExpiresAt: Date.parse('2026-10-22T16:00:00Z'),
      credits: [
        {
          status: 'available',
          expiresAt: Date.parse('2026-10-22T16:00:00Z'),
          grantedAt: Date.parse('2026-09-22T16:00:00Z')
        }
      ]
    })
  })

  it('sums grants and reports the soonest expiry', () => {
    const result = mapClaudeResetGrants(
      eligibleBlock([
        launchGrant({ id: 'a', resets_left: 2, resets_total: 2 }),
        launchGrant({ id: 'b', ends_at: '2026-10-01T00:00:00Z' })
      ]),
      NOW
    )
    expect(result?.availableCount).toBe(3)
    expect(result?.nextExpiresAt).toBe(Date.parse('2026-10-01T00:00:00Z'))
  })

  it('reports zero once the reset is spent', () => {
    const result = mapClaudeResetGrants(eligibleBlock([launchGrant({ resets_left: 0 })]), NOW)
    expect(result).toMatchObject({ availableCount: 0, totalEarnedCount: 1, nextExpiresAt: null })
    expect(result?.credits?.[0]?.status).toBe('used')
  })

  it('does not count paused or expired grants', () => {
    const result = mapClaudeResetGrants(
      eligibleBlock([
        launchGrant({ id: 'paused', paused: true }),
        launchGrant({ id: 'old', ends_at: '2026-09-01T00:00:00Z' })
      ]),
      NOW
    )
    expect(result?.availableCount).toBe(0)
    expect(result?.credits?.map((credit) => credit.status)).toEqual(['paused', 'expired'])
  })

  it('does not count a grant that has not started yet', () => {
    const result = mapClaudeResetGrants(
      eligibleBlock([launchGrant({ starts_at: '2026-10-01T00:00:00Z' })]),
      NOW
    )
    expect(result).toMatchObject({ availableCount: 0, nextExpiresAt: null })
    expect(result?.credits?.[0]?.status).toBe('scheduled')
  })

  it('counts a held reset even while the server says it cannot be used right now', () => {
    const result = mapClaudeResetGrants(
      eligibleBlock([launchGrant({ usable_now: false, use_requires_limit: true })]),
      NOW
    )
    expect(result?.availableCount).toBe(1)
  })

  it('hides resets for an ineligible account', () => {
    expect(
      mapClaudeResetGrants({ eligible: false, ineligible_reason: 'surface', grants: [] }, NOW)
    ).toBeNull()
  })

  it('hides resets when the block is absent or malformed', () => {
    expect(mapClaudeResetGrants(undefined, NOW)).toBeNull()
    expect(mapClaudeResetGrants(null, NOW)).toBeNull()
    expect(mapClaudeResetGrants({ eligible: true }, NOW)).toBeNull()
    expect(mapClaudeResetGrants('yes', NOW)).toBeNull()
  })

  it('skips grants without a usable reset count', () => {
    const result = mapClaudeResetGrants(
      eligibleBlock([launchGrant({ resets_left: '1' }), null, launchGrant()]),
      NOW
    )
    expect(result?.availableCount).toBe(1)
    expect(result?.credits).toHaveLength(1)
  })

  it('hides resets when no grant is readable instead of reporting zero', () => {
    expect(
      mapClaudeResetGrants(eligibleBlock([launchGrant({ resets_left: '1' }), null]), NOW)
    ).toBeNull()
  })

  it('reports zero for an eligible account with no grants yet', () => {
    expect(mapClaudeResetGrants(eligibleBlock([]), NOW)?.availableCount).toBe(0)
  })
})
