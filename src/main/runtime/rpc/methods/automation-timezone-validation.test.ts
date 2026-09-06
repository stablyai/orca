import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdate } from './automation-schemas'

describe('automation RPC timezone validation', () => {
  it.each(['Mars/Olympus_Mons', 'Not a timezone'])(
    'rejects invalid timezones on create and update: %s',
    (timezone) => {
      expect(
        AutomationCreate.safeParse({
          name: 'Review',
          prompt: 'Review',
          agentId: 'codex',
          timezone,
          rrule: '0 9 * * *',
          dtstart: 0
        }).success
      ).toBe(false)
      expect(AutomationUpdate.safeParse({ id: 'auto-1', updates: { timezone } }).success).toBe(
        false
      )
    }
  )

  it.each([undefined, 'UTC', 'Asia/Shanghai', 'America/New_York'])(
    'preserves omitted and valid timezones: %s',
    (timezone) => {
      expect(
        AutomationCreate.safeParse({
          name: 'Review',
          prompt: 'Review',
          agentId: 'codex',
          timezone,
          rrule: '0 9 * * *',
          dtstart: 0
        }).success
      ).toBe(true)
      expect(AutomationUpdate.safeParse({ id: 'auto-1', updates: { timezone } }).success).toBe(true)
    }
  )
})
