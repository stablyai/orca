import { afterEach, describe, expect, it, vi } from 'vitest'
import { automationDraftPatch, newAutomationDraft } from './automation-draft'

describe('automationDraftPatch', () => {
  afterEach(() => vi.useRealTimers())

  it('re-anchors dtstart when the rule changes, so an interval counts from the save', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-12T15:00:00Z') })
    const original = { ...newAutomationDraft(), name: 'Nightly' }
    const rrule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=11;BYMINUTE=0'
    expect(automationDraftPatch({ ...original, rrule }, original)).toEqual({
      rrule,
      dtstart: Date.parse('2026-11-12T15:00:00Z')
    })
    expect(automationDraftPatch({ ...original, name: 'Renamed' }, original)).toEqual({
      name: 'Renamed'
    })
  })
})
