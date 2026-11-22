import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { nextAutomationOccurrenceAfter } from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import { reseedOffZoneNextRuns } from './automation-zone-reseed'

afterEach(() => vi.unstubAllEnvs())

const NOW = Date.parse('2026-05-13T12:00:00Z')
const DTSTART = Date.parse('2026-05-01T00:00:00Z')
const DAILY_NINE = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reseeding reads only the schedule fields set here.
const automation = (fields: Partial<Automation>) => ({ id: 'a1', ...fields }) as Automation

/** What an Orca that read schedules on the host clock saved. */
function savedOnHostClock(timezone: string, timezoneExplicit?: true): Automation {
  return automation({
    rrule: DAILY_NINE,
    dtstart: DTSTART,
    timezone,
    ...(timezoneExplicit ? { timezoneExplicit } : {}),
    nextRunAt: nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, NOW)
  })
}

// Why: on Windows, unsetting a stubbed TZ doesn't restore the OS zone, so it would leak into later tests.
describe.skipIf(process.platform === 'win32')(
  're-seeding next runs saved on the host clock',
  () => {
    it.each([
      // West of the host: catch-up would have recorded a Missed run at 9:00 UTC.
      ['America/New_York', '2026-05-13T13:00:00.000Z'],
      // East of the host: catch-up would have run 9:00 Tokyo late, at 9:00 UTC.
      ['Asia/Tokyo', '2026-05-14T00:00:00.000Z']
    ])('moves a server automation saved in %s to its own 9:00', (timezone, expected) => {
      vi.stubEnv('TZ', 'UTC')
      const saved = savedOnHostClock(timezone)
      expect(new Date(saved.nextRunAt).toISOString()).toBe('2026-05-14T09:00:00.000Z')

      const { automations, changed } = reseedOffZoneNextRuns([saved], 'runtime', NOW)

      expect(changed).toBe(true)
      expect(new Date(automations[0]!.nextRunAt).toISOString()).toBe(expected)
    })

    it("leaves a desktop's default-zone rows on its clock, and re-seeds only a named zone", () => {
      vi.stubEnv('TZ', 'UTC')
      const defaultZone = savedOnHostClock('America/New_York')
      const named = savedOnHostClock('Asia/Tokyo', true)

      const { automations } = reseedOffZoneNextRuns([defaultZone, named], 'desktop', NOW)

      expect(automations[0]).toBe(defaultZone)
      expect(new Date(automations[1]!.nextRunAt).toISOString()).toBe('2026-05-14T00:00:00.000Z')
    })

    it('leaves a next run that is already one of its occurrences', () => {
      vi.stubEnv('TZ', 'UTC')
      const onZone = automation({
        rrule: DAILY_NINE,
        dtstart: DTSTART,
        timezone: 'Asia/Tokyo',
        nextRunAt: nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, NOW, 'Asia/Tokyo')
      })
      const onHost = savedOnHostClock('UTC')

      expect(reseedOffZoneNextRuns([onZone, onHost], 'runtime', NOW)).toEqual({
        automations: [onZone, onHost],
        changed: false
      })
    })

    it('leaves a schedule with no next run for the dispatcher to report', () => {
      // February 30th never comes.
      const broken = automation({
        rrule: '0 0 30 2 *',
        dtstart: DTSTART,
        timezone: 'Asia/Tokyo',
        nextRunAt: 5
      })
      expect(reseedOffZoneNextRuns([broken], 'runtime', NOW).changed).toBe(false)
    })
  }
)
