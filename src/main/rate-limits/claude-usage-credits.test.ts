import { describe, expect, it } from 'vitest'
import { mapClaudeExtraUsage } from './claude-usage-credits'

describe('Claude spend currency ownership', () => {
  it('keeps the currency of a balance-only response', () => {
    expect(
      mapClaudeExtraUsage({
        spend: { enabled: true, balance: { amount_minor: 1200, currency: 'EUR', exponent: 2 } }
      })
    ).toMatchObject({ balance: 12, currencyCode: 'EUR', spent: null, spendLimit: null })
  })
  it.each(['used', 'limit', 'cap'] as const)(
    'rejects a balance with an inconsistent %s currency',
    (field) => {
      const money = { amount_minor: 300, currency: 'USD', exponent: 2 }
      const spend = {
        balance: { amount_minor: 1200, currency: 'EUR', exponent: 2 },
        ...(field === 'cap' ? { cap: { money } } : { [field]: money })
      }
      expect(mapClaudeExtraUsage({ spend })).toBeNull()
    }
  )
  it('normalizes compatible currency codes without converting their amounts', () => {
    expect(
      mapClaudeExtraUsage({
        spend: {
          used: { amount_minor: 200, currency: ' eur ', exponent: 2 },
          balance: { amount_minor: 1200, currency: 'EUR', exponent: 2 }
        }
      })
    ).toMatchObject({ balance: 12, spent: 2, currencyCode: 'EUR' })
  })
  it('refuses an invalid currency code instead of labeling it USD', () => {
    expect(
      mapClaudeExtraUsage({ spend: { balance: { amount_minor: 1200, currency: '', exponent: 2 } } })
    ).toBeNull()
  })
})
