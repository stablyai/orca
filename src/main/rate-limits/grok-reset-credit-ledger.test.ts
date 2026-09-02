import { describe, expect, it, vi } from 'vitest'
import { MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS } from '../../shared/grok-reset-credit-attempt-ledger'
import type { GrokResetCreditAttemptLedger } from '../../shared/grok-reset-credit-attempt-ledger'
import { GrokResetCreditLedger } from './grok-reset-credit-ledger'

describe('GrokResetCreditLedger', () => {
  it('retains pending attempts while pruning old settled replays', () => {
    let durable: GrokResetCreditAttemptLedger = { version: 1, attempts: [] }
    const store = {
      getGrokResetCreditAttemptLedger: vi.fn(() => structuredClone(durable)),
      replaceGrokResetCreditAttemptLedgerAndFlush: vi.fn((next: GrokResetCreditAttemptLedger) => {
        durable = structuredClone(next)
      })
    }
    const ledger = new GrokResetCreditLedger(store as never)
    const pendingKey = '00000000-0000-4000-8000-000000000000'
    const preOperationWeekly = {
      usedPercent: 80,
      windowMinutes: 10_080,
      resetsAt: null,
      resetDescription: null
    }
    ledger.markProviderPending(pendingKey, preOperationWeekly)

    for (let index = 1; index <= MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS + 2; index += 1) {
      const key = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      ledger.markProviderPending(key, preOperationWeekly)
      ledger.markSettled(key, 'reset')
    }

    expect(durable.attempts.filter((attempt) => attempt.state === 'settled')).toHaveLength(
      MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS
    )
    expect(durable.attempts).toContainEqual({
      idempotencyKey: pendingKey,
      state: 'providerPending',
      preOperationWeekly
    })
    expect(
      durable.attempts.some((attempt) => attempt.idempotencyKey.endsWith('000000000001'))
    ).toBe(false)
  })
})
