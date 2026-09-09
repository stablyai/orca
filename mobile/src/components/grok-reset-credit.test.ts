import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from './accounts-snapshot'
import {
  getGrokResetCreditOutcomeCopy,
  getGrokResetCreditSummary,
  requestGrokResetCredit,
  resetGrokResetCreditRequestsForTests
} from './grok-reset-credit'
import { resetGrokResetAttemptJournalForTests } from '../storage/grok-reset-attempt-journal'

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

function makeLimits(availableCount: number, nextExpiresAt: number | null): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: {
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: nextExpiresAt,
      resetDescription: null
    },
    rateLimitResetCredits: { availableCount, nextExpiresAt },
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    grok: makeLimits(0, null),
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

describe('Grok reset credit', () => {
  let stored: string | null

  beforeEach(() => {
    stored = null
    resetGrokResetCreditRequestsForTests()
    resetGrokResetAttemptJournalForTests()
    storage.getItem.mockReset().mockImplementation(async () => stored)
    storage.setItem.mockReset().mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    storage.removeItem.mockReset().mockImplementation(async () => {
      stored = null
    })
  })

  it('hides empty inventories and labels a remaining token', () => {
    const now = Date.parse('2026-08-27T12:00:00Z')
    expect(getGrokResetCreditSummary(null, now)).toBeNull()
    expect(getGrokResetCreditSummary(makeLimits(0, now + 60_000), now)).toBeNull()
    expect(getGrokResetCreditSummary(makeLimits(1, now + 2 * 60 * 60_000), now)).toEqual({
      availableCount: 1,
      availabilityLabel: '1 reset available',
      expiryLabel: 'Expires in 2h'
    })
  })

  it.each([
    ['reset', 'Rate limits reset'],
    ['noCredit', 'No reset available'],
    ['nothingToReset', 'Nothing to reset'],
    ['alreadyRedeemed', 'Reset already applied'],
    ['usageUnavailable', 'Could not verify Grok usage']
  ] as const)('maps %s host outcomes', (outcome, title) => {
    expect(getGrokResetCreditOutcomeCopy(outcome).title).toBe(title)
  })

  it('describes unavailable usage as retryable', () => {
    expect(getGrokResetCreditOutcomeCopy('usageUnavailable')).toEqual({
      title: 'Could not verify Grok usage',
      message: 'Try again.'
    })
  })

  it('persists and sends the phone-owned key without a provider token id', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { outcome: 'noCredit', snapshot: SNAPSHOT }
    })

    const result = await requestGrokResetCredit(
      { sendRequest },
      { hostId: 'host-1', createIdempotencyKey: () => '22222222-2222-4222-8222-222222222222' }
    )

    expect(result).toMatchObject({ outcome: 'noCredit', attemptJournalRetained: false })
    expect(storage.setItem).toHaveBeenCalledBefore(sendRequest)
    expect(sendRequest).toHaveBeenCalledWith(
      'accounts.consumeGrokResetCredit',
      { idempotencyKey: '22222222-2222-4222-8222-222222222222' },
      { timeoutMs: 90_000 }
    )
    expect(JSON.stringify(sendRequest.mock.calls[0]?.[1])).not.toMatch(/restok_/)
  })

  it('retains and reuses the attempt key after an unknown RPC outcome', async () => {
    const create = vi.fn().mockReturnValue('33333333-3333-4333-8333-333333333333')
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({
        ok: true,
        result: { outcome: 'alreadyRedeemed', snapshot: SNAPSHOT }
      })

    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).rejects.toThrow('connection lost')
    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed' })

    expect(create).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })

  it('retains and reuses the attempt key when Grok usage is unavailable', async () => {
    const create = vi.fn().mockReturnValue('44444444-4444-4444-8444-444444444444')
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { outcome: 'usageUnavailable', snapshot: SNAPSHOT }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { outcome: 'nothingToReset', snapshot: SNAPSHOT }
      })

    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).resolves.toMatchObject({ outcome: 'usageUnavailable', attemptJournalRetained: true })
    expect(storage.removeItem).not.toHaveBeenCalled()
    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).resolves.toMatchObject({ outcome: 'nothingToReset', attemptJournalRetained: false })

    expect(create).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })

  it('keeps an unknown future outcome non-authoritative for older mobile clients', async () => {
    const create = vi.fn().mockReturnValue('55555555-5555-4555-8555-555555555555')
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        // Why: clients predating usageUnavailable reach this same unknown-value branch before cleanup.
        result: { outcome: 'futureOutcome', snapshot: SNAPSHOT }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { outcome: 'alreadyRedeemed', snapshot: SNAPSHOT }
      })

    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).rejects.toThrow('Invalid reset response from host')
    expect(storage.removeItem).not.toHaveBeenCalled()
    await expect(
      requestGrokResetCredit({ sendRequest }, { hostId: 'host-1', createIdempotencyKey: create })
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed' })

    expect(create).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls[0]?.[1]).toEqual(sendRequest.mock.calls[1]?.[1])
  })
})
