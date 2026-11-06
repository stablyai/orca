import { describe, expect, it } from 'vitest'
import { parseOllamaBalanceResponse, parseOllamaUsageResponse } from './ollama-usage-fetcher'

describe('parseOllamaBalanceResponse', () => {
  it('maps the modern USD allowance plan to an extraUsage balance', () => {
    const parsed = parseOllamaBalanceResponse({
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' }
      },
      purchased: { balance_usd: 25 }
    })
    expect(parsed.session).toBeNull()
    expect(parsed.weekly).toBeNull()
    const balance = parsed.extraUsage
    expect(balance?.unit === 'currency' ? balance : null).toEqual({
      unit: 'currency',
      balance: 72.5,
      currencyCode: 'USD',
      spent: 27.5,
      spendLimit: 100,
      spentPercent: 27.5,
      enabled: true,
      disabledReason: null,
      resetsAt: Date.parse('2026-10-15T09:30:00Z')
    })
  })

  it('maps the legacy session/weekly percent plan and keeps purchased balance separate', () => {
    const parsed = parseOllamaBalanceResponse({
      included: {
        session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
        weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' }
      },
      purchased: { balance_usd: 25 }
    })
    expect(parsed.session).toEqual({
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: Date.parse('2026-10-01T07:00:00Z'),
      resetDescription: null
    })
    expect(parsed.weekly?.usedPercent).toBe(60)
    expect(parsed.weekly?.windowMinutes).toBe(10080)
    const balance = parsed.extraUsage
    expect(balance?.unit === 'currency' ? balance : null).toEqual({
      unit: 'currency',
      balance: 25,
      currencyCode: 'USD',
      spent: null,
      spendLimit: null,
      spentPercent: null,
      enabled: true,
      disabledReason: null,
      resetsAt: null
    })
  })

  it('returns nulls for malformed or missing payloads', () => {
    const empty = { session: null, weekly: null, extraUsage: null, purchasedBalanceUsd: null }
    expect(parseOllamaBalanceResponse(null)).toEqual(empty)
    expect(parseOllamaBalanceResponse({ error: 'invalid credentials' })).toEqual(empty)
    expect(parseOllamaBalanceResponse({ included: { balance_usd: 'x' }, purchased: {} })).toEqual(
      empty
    )
  })

  it('keeps purchased credits distinct from the included allowance on modern plans', () => {
    const parsed = parseOllamaBalanceResponse({
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' }
      },
      purchased: { balance_usd: 25 }
    })
    expect(parsed.purchasedBalanceUsd).toBe(25)
    expect(parsed.extraUsage?.balance).toBe(72.5)
  })

  it('renders zero usedPercent when nothing of the allowance was spent', () => {
    const parsed = parseOllamaBalanceResponse({
      included: {
        balance_usd: 100,
        allowance_usd: 100,
        period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' }
      },
      purchased: { balance_usd: 0 }
    })
    const balance = parsed.extraUsage
    expect(balance?.unit === 'currency' ? balance.spent : null).toBe(0)
    expect(balance?.unit === 'currency' ? balance.spentPercent : null).toBe(0)
  })
})

describe('parseOllamaUsageResponse', () => {
  it('reads totals including token counts from the 30d usage response', () => {
    expect(
      parseOllamaUsageResponse({
        range: '30d',
        totals: {
          request_count: 15,
          usage_usd: 0.01718,
          input_tokens: 106000,
          cached_input_tokens: 46000,
          output_tokens: 13600
        }
      })
    ).toEqual({
      spentUsd: 0.01718,
      requestCount: 15,
      inputTokens: 106000,
      cachedInputTokens: 46000,
      outputTokens: 13600,
      purchasedBalanceUsd: null
    })
  })

  it('returns nulls for malformed payloads', () => {
    const emptyTotals = {
      spentUsd: null,
      requestCount: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      purchasedBalanceUsd: null
    }
    expect(parseOllamaUsageResponse(null)).toEqual(emptyTotals)
    expect(parseOllamaUsageResponse({})).toEqual(emptyTotals)
    expect(parseOllamaUsageResponse({ totals: { usage_usd: 'x' } })).toEqual(emptyTotals)
  })
})
