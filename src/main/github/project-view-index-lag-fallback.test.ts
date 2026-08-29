import { describe, expect, it } from 'vitest'
import { preferSuccessfulIndexLagFallback } from './project-view'

describe('preferSuccessfulIndexLagFallback', () => {
  it('keeps the initial empty ok when the fallback fails', () => {
    const initial = { ok: true as const, totalCount: 0, rows: [] as never[] }
    const fallback = {
      ok: false as const,
      error: { type: 'rate_limited' as const, message: 'slow' }
    }
    expect(preferSuccessfulIndexLagFallback(initial, fallback)).toBe(initial)
  })

  it('uses a successful fallback over the empty index result', () => {
    const initial = { ok: true as const, totalCount: 0, rows: [] as never[] }
    const fallback = {
      ok: true as const,
      totalCount: 2,
      rows: [{ id: 'a' }, { id: 'b' }] as never[]
    }
    expect(preferSuccessfulIndexLagFallback(initial, fallback)).toBe(fallback)
  })
})
