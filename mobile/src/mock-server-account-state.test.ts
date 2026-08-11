import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeMockCodexResetCredit,
  createMockAccountsSnapshot,
  getMockCodexResetScope,
  resetMockAccountState,
  selectMockCodexAccount
} from '../scripts/mock-server-account-state'

const FIRST_OPERATION_ID = '11111111-1111-4111-8111-111111111111'

describe('mock account reset state', () => {
  beforeEach(() => {
    resetMockAccountState(1_700_000_000_000)
  })

  it('keeps reset and expiry deadlines fixed between snapshots', () => {
    const first = createMockAccountsSnapshot()
    const second = createMockAccountsSnapshot()

    expect(second.rateLimits.codex.session?.resetsAt).toBe(first.rateLimits.codex.session?.resetsAt)
    expect(second.rateLimits.codex.rateLimitResetCredits.nextExpiresAt).toBe(
      first.rateLimits.codex.rateLimitResetCredits.nextExpiresAt
    )
  })

  it('resets only the selected account and updates its visible usage', () => {
    const personalScope = getMockCodexResetScope()
    expect(personalScope).not.toBeNull()

    expect(consumeMockCodexResetCredit(FIRST_OPERATION_ID, personalScope)).toMatchObject({
      outcome: 'reset',
      scope: personalScope
    })
    const personalAfter = createMockAccountsSnapshot()
    expect(personalAfter.rateLimits.codex.session?.usedPercent).toBe(0)
    expect(personalAfter.rateLimits.codex.rateLimitResetCredits.availableCount).toBe(0)

    selectMockCodexAccount('codex-team')
    const team = createMockAccountsSnapshot()
    expect(team.rateLimits.codex.session?.usedPercent).toBe(100)
    expect(team.rateLimits.codex.rateLimitResetCredits.availableCount).toBe(1)
    expect(getMockCodexResetScope()?.accountId).toBe('codex-team')
  })

  it('replays the same operation result and authoritatively discards a stale attempt', () => {
    const scope = getMockCodexResetScope()
    expect(scope).not.toBeNull()
    const first = consumeMockCodexResetCredit(FIRST_OPERATION_ID, scope)
    expect(consumeMockCodexResetCredit(FIRST_OPERATION_ID, scope)).toEqual(first)

    expect(() => consumeMockCodexResetCredit('not-a-uuid', scope)).toThrow('Invalid idempotencyKey')
    expect(consumeMockCodexResetCredit('22222222-2222-4222-8222-222222222222', scope)).toEqual({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope
    })
  })
})
