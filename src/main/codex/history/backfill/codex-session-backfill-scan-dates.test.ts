import { describe, expect, it } from 'vitest'
import {
  getCodexSessionBackfillDate,
  getCodexSessionBackfillDatesBetween
} from './codex-session-backfill-scan-dates'
import type { CodexSessionBackfillDate } from './codex-session-backfill-types'

describe('codex session backfill scan dates', () => {
  // Codex names rollout directories with OffsetDateTime::now_local(); a UTC date misses them.
  it.each<[string, string, CodexSessionBackfillDate]>([
    ['Asia/Seoul', '2026-10-26T15:53:24Z', ['2026', '10', '27']],
    ['America/Los_Angeles', '2026-10-27T05:00:00Z', ['2026', '10', '26']]
  ])(
    'targets the directory a %s launch writes, not the UTC date',
    (timeZone, instant, expected) => {
      const previousTimeZone = process.env.TZ
      process.env.TZ = timeZone
      try {
        expect(getCodexSessionBackfillDate(new Date(instant))).toEqual(expected)
        expect(getCodexSessionBackfillDatesBetween(new Date(instant), new Date(instant))).toEqual([
          expected
        ])
      } finally {
        if (previousTimeZone === undefined) {
          delete process.env.TZ
        } else {
          process.env.TZ = previousTimeZone
        }
      }
    }
  )
})
