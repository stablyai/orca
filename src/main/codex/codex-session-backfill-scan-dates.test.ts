import { describe, expect, it } from 'vitest'
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
