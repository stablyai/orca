import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdate } from './automation-schemas'

describe('automation RPC recurrence validation', () => {
  it.each([
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
    'FREQ=DAILY;COUNT=1',
    'FREQ=DAILY;UNTIL=20260906T090000Z'
  ])('rejects unsupported RRULE fields on create and update: %s', (rrule) => {
    expect(
      AutomationCreate.safeParse({
        name: 'Review',
        prompt: 'Review changes',
        agentId: 'codex',
        rrule,
        dtstart: 0
      }).success
    ).toBe(false)
    expect(AutomationUpdate.safeParse({ id: 'auto-1', updates: { rrule } }).success).toBe(false)
  })
})
