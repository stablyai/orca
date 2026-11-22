import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { nextAutomationOccurrenceAfter } from '../../../../shared/automations/scheduling/automation-schedule-occurrences'
import { prepareOrcadMigrationAutomationState } from './orcad-destination-automation-state'
import { DORMANT_AUTOMATION } from '../catalog-commit/persistence-orcad-migration-catalog-fixture'

const DAILY_NINE = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
const DTSTART = Date.parse('2026-05-01T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-13T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

// Zones no test host uses: one west and one east of every host.
function fromDesktop(id: string, timezone: string): Automation {
  return {
    ...DORMANT_AUTOMATION,
    id,
    timezone,
    rrule: DAILY_NINE,
    dtstart: DTSTART,
    // The desktop computed it on its own clock.
    nextRunAt: nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, Date.now())
  }
}

function emptyState(automations: Automation[] = []): PersistedState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the import reads only these two lists.
  return { automations, automationRuns: [] } as unknown as PersistedState
}

describe('automations imported into an orcad', () => {
  it('re-seed their next run on the zone the server reads, west and east', () => {
    const rows = [
      fromDesktop('west', 'Pacific/Honolulu'),
      fromDesktop('east', 'Pacific/Kiritimati')
    ]

    const { newAutomations } = prepareOrcadMigrationAutomationState(rows, [], emptyState())

    expect(newAutomations.map((row) => row.nextRunAt)).toEqual(
      rows.map((row) =>
        nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, Date.now(), row.timezone)
      )
    )
    expect(newAutomations.map((row) => row.nextRunAt)).not.toContain(rows[0]!.nextRunAt)
  })

  it('still match a row already imported and re-seeded, on a retried import', () => {
    const row = fromDesktop('west', 'Pacific/Honolulu')
    const [imported] = prepareOrcadMigrationAutomationState([row], [], emptyState()).newAutomations

    const retried = prepareOrcadMigrationAutomationState([row], [], emptyState([imported!]))

    expect(retried.newAutomations).toEqual([])
  })
})
