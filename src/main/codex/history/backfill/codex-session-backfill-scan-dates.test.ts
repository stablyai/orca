import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCodexSessionBackfillDate,
  getCodexSessionBackfillDatesBetween
} from './codex-session-backfill-scan-dates'
import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

afterEach(() => vi.unstubAllEnvs())

describe('codex session backfill scan dates', () => {
  it.each<[string, string, CodexSessionBackfillDate]>([
    ['Asia/Seoul', '2026-10-26T15:53:24Z', ['2026', '10', '27']],
    ['America/Los_Angeles', '2026-10-27T05:00:00Z', ['2026', '10', '26']]
  ])('targets the local directory written by a %s launch', (timeZone, instant, expected) => {
    vi.stubEnv('TZ', timeZone)
    expect(getCodexSessionBackfillDate(new Date(instant))).toEqual(expected)
    expect(
      getCodexSessionBackfillDatesBetween(new Date(instant), new Date(instant))
    ).toContainEqual(expected)
  })

  it.each([
    [
      '2026-03-08T07:30:00Z',
      '2026-03-10T06:30:00Z',
      [
        ['2026', '03', '06'],
        ['2026', '03', '07'],
        ['2026', '03', '08'],
        ['2026', '03', '09'],
        ['2026', '03', '10']
      ]
    ],
    [
      '2026-11-01T06:30:00Z',
      '2026-11-03T07:30:00Z',
      [
        ['2026', '10', '30'],
        ['2026', '10', '31'],
        ['2026', '11', '01'],
        ['2026', '11', '02'],
        ['2026', '11', '03']
      ]
    ]
  ])('covers local calendar days and neighbors across DST from %s', (start, end, expected) => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(getCodexSessionBackfillDatesBetween(new Date(start), new Date(end))).toEqual(expected)
  })
})
