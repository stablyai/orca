import { describe, expect, it } from 'vitest'
import {
  formatAutomationEventTrigger,
  parseAutomationEventTrigger
} from '../automations/automation-event-trigger-spec'

describe('--on Google rules', () => {
  it('reads a Gmail rule with its filters, and writes it back the same', () => {
    const rule = parseAutomationEventTrigger(
      'gmail.new_email from=Sam@Acme.com,acme.com to=ada@acme.dev subject="Q3 invoice" label=Clients account=Ada@Acme.dev'
    )
    expect(rule).toMatchObject({
      source: 'gmail',
      event: 'new_email',
      from: ['acme.com', 'sam@acme.com'],
      to: ['ada@acme.dev'],
      subjectContains: 'Q3 invoice',
      label: 'Clients',
      account: 'ada@acme.dev'
    })
    expect(parseAutomationEventTrigger(formatAutomationEventTrigger(rule))).toEqual(rule)
  })

  it('reads a meeting rule, ten minutes before on the primary calendar by default', () => {
    const rule = parseAutomationEventTrigger('calendar.starting_soon')
    expect(rule).toMatchObject({ source: 'calendar', event: 'starting_soon', minutesBefore: 10 })
    expect(rule).not.toHaveProperty('calendar')
    const team = parseAutomationEventTrigger(
      'calendar.starting_soon before=30 calendar=team@group.calendar.google.com'
    )
    expect(formatAutomationEventTrigger(team)).toBe(
      'calendar.starting_soon before=30 calendar=team@group.calendar.google.com'
    )
    expect(parseAutomationEventTrigger('calendar.starting_soon before=10').id).toBe(rule.id)
  })

  it('refuses filters a rule does not have, and minutes out of range', () => {
    expect(() => parseAutomationEventTrigger('gmail.new_email in=C1')).toThrow('Use from=, to=')
    expect(() => parseAutomationEventTrigger('calendar.starting_soon before=soon')).toThrow(
      'before= takes minutes'
    )
    expect(() => parseAutomationEventTrigger('calendar.starting_soon before=99999')).toThrow(
      'before= takes minutes'
    )
  })
})
