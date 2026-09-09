import { describe, expect, it, vi } from 'vitest'
import {
  compareCodexSessionBackfillDates,
  expandCodexSessionBackfillDatesThroughToday,
  getCodexSessionBackfillDate,
  getCodexSessionBackfillDatesBetween,
  isCodexSessionBackfillDate,
  mergeCodexSessionBackfillDates,
  parseCodexSessionBackfillDates,
  subtractCodexSessionBackfillDates
} from './codex-session-backfill-scan-dates'
import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

describe('codex session backfill scan dates', () => {
  it('reads UTC parts so a local evening never lands on the wrong directory', () => {
    expect(getCodexSessionBackfillDate(new Date('2026-08-05T23:59:59Z'))).toEqual([
      '2026',
      '08',
      '05'
    ])
    expect(getCodexSessionBackfillDate(new Date('2026-01-02T00:00:00Z'))).toEqual([
      '2026',
      '01',
      '02'
    ])
  })

  it('rejects anything that is not a zero-padded YYYY/MM/DD triple', () => {
    expect(isCodexSessionBackfillDate(['2026', '08', '05'])).toBe(true)
    expect(isCodexSessionBackfillDate(['2026', '8', '05'])).toBe(false)
    expect(isCodexSessionBackfillDate(['2026', '08'])).toBe(false)
    expect(isCodexSessionBackfillDate('2026-08-05')).toBe(false)
  })

  it('rejects dates the calendar never produced', () => {
    expect(isCodexSessionBackfillDate(['2026', '99', '99'])).toBe(false)
    expect(isCodexSessionBackfillDate(['2026', '02', '30'])).toBe(false)
    expect(isCodexSessionBackfillDate(['2025', '02', '29'])).toBe(false)
    expect(isCodexSessionBackfillDate(['2026', '00', '10'])).toBe(false)
    expect(isCodexSessionBackfillDate(['2024', '02', '29'])).toBe(true)
    expect(isCodexSessionBackfillDate(['2026', '12', '31'])).toBe(true)
  })

  it('merges and subtracts date sets by identity, not by reference', () => {
    const merged = mergeCodexSessionBackfillDates(
      [
        ['2026', '08', '06'],
        ['2026', '08', '05']
      ],
      [['2026', '08', '06']],
      undefined
    )

    expect(merged).toEqual([
      ['2026', '08', '05'],
      ['2026', '08', '06']
    ])
    expect(subtractCodexSessionBackfillDates(merged, [['2026', '08', '05']])).toEqual([
      ['2026', '08', '06']
    ])
    expect(compareCodexSessionBackfillDates(merged[0], merged[1])).toBeLessThan(0)
  })

  it('discards unparseable persisted dates instead of scanning bogus roots', () => {
    expect(parseCodexSessionBackfillDates([['2026', '08', '05'], 'nope', ['2026'], null])).toEqual([
      ['2026', '08', '05']
    ])
    expect(parseCodexSessionBackfillDates('not an array')).toEqual([])
  })

  it('walks every date a launch could have spanned, including across a month end', () => {
    expect(
      getCodexSessionBackfillDatesBetween(
        new Date('2026-07-31T23:00:00Z'),
        new Date('2026-08-02T01:00:00Z')
      )
    ).toEqual([
      ['2026', '07', '31'],
      ['2026', '08', '01'],
      ['2026', '08', '02']
    ])
  })

  it('widens a pending set into the contiguous window that ends today', () => {
    expect(
      expandCodexSessionBackfillDatesThroughToday([['2026', '08', '05']], ['2026', '08', '07'], 31)
    ).toEqual([
      ['2026', '08', '05'],
      ['2026', '08', '06'],
      ['2026', '08', '07']
    ])
  })

  it('leaves an empty pending set empty rather than inventing today', () => {
    expect(expandCodexSessionBackfillDatesThroughToday([], ['2026', '08', '07'], 31)).toEqual([])
  })

  it('gives up on a window wider than the bound so a full walk can recertify', () => {
    expect(
      expandCodexSessionBackfillDatesThroughToday([['2026', '01', '01']], ['2026', '08', '07'], 31)
    ).toBeNull()
  })
})

describe('bounded backfill range construction', () => {
  it('does not allocate rejected dates for a decades-old pending marker', () => {
    const advance = vi.spyOn(Date.prototype, 'setUTCDate')
    try {
      expect(
        expandCodexSessionBackfillDatesThroughToday(
          [['2000', '01', '01']],
          ['2026', '09', '07'],
          31
        )
      ).toBeNull()
      expect(advance).not.toHaveBeenCalled()
    } finally {
      advance.mockRestore()
    }
  })

  it('keeps exact, fractional, leap-day and future-clock bounds', () => {
    const dates = [['2024', '02', '28']] as [string, string, string][]
    expect(expandCodexSessionBackfillDatesThroughToday(dates, ['2024', '03', '01'], 3)).toEqual([
      ['2024', '02', '28'],
      ['2024', '02', '29'],
      ['2024', '03', '01']
    ])
    expect(expandCodexSessionBackfillDatesThroughToday(dates, ['2024', '03', '01'], 2.5)).toBeNull()
    expect(
      expandCodexSessionBackfillDatesThroughToday([['2024', '03', '01']], ['2024', '02', '28'], 3)
    ).toEqual(expandCodexSessionBackfillDatesThroughToday(dates, ['2024', '03', '01'], 3))
  })

  // The arithmetic cardinality gate must admit and reject exactly what enumerating the range
  // would, on every calendar edge that has ever broken a day count: leap days, century rules,
  // year rollover, and the DST switches the UTC-only arithmetic has to stay indifferent to.
  it.each<[string, CodexSessionBackfillDate, CodexSessionBackfillDate]>([
    ['leap February', ['2024', '02', '27'], ['2024', '03', '02']],
    ['non-leap February', ['2023', '02', '27'], ['2023', '03', '02']],
    ['US spring-forward', ['2024', '03', '09'], ['2024', '03', '11']],
    ['US fall-back', ['2024', '11', '02'], ['2024', '11', '04']],
    ['EU spring-forward', ['2025', '03', '29'], ['2025', '03', '31']],
    ['southern-hemisphere DST', ['2025', '04', '05'], ['2025', '04', '07']],
    ['year rollover', ['2024', '12', '30'], ['2025', '01', '02']],
    ['leap century', ['1999', '12', '31'], ['2000', '01', '02']],
    ['non-leap century', ['2100', '02', '27'], ['2100', '03', '02']],
    ['30-day month end', ['2026', '04', '29'], ['2026', '05', '02']],
    ['single day', ['2026', '09', '07'], ['2026', '09', '07']]
  ])('matches the enumerated range at the %s cap boundary', (_label, from, to) => {
    const start = new Date(Date.UTC(Number(from[0]), Number(from[1]) - 1, Number(from[2])))
    const end = new Date(Date.UTC(Number(to[0]), Number(to[1]) - 1, Number(to[2])))
    const enumerated = getCodexSessionBackfillDatesBetween(start, end)
    const pending = [from]

    expect(expandCodexSessionBackfillDatesThroughToday(pending, to, enumerated.length)).toEqual(
      enumerated
    )
    expect(
      expandCodexSessionBackfillDatesThroughToday(pending, to, enumerated.length - 1)
    ).toBeNull()
  })
})
