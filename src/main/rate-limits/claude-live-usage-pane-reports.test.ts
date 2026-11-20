import { describe, expect, it } from 'vitest'
import {
  ClaudeLiveUsagePaneReports,
  MAX_TRACKED_CLAUDE_PANES
} from './claude-live-usage-pane-reports'

const RESETS_AT = Date.parse('2026-03-02T13:00:00Z')
const win = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt: RESETS_AT,
  resetDescription: null
})

describe('ClaudeLiveUsagePaneReports', () => {
  it('forgets the least recently posting pane beyond the cap', () => {
    const reports = new ClaudeLiveUsagePaneReports()
    reports.remember('pane-0', null, { session: win(100), weekly: null })
    reports.remember('pane-1', null, { session: win(100), weekly: null })
    for (let pane = 2; pane <= MAX_TRACKED_CLAUDE_PANES; pane += 1) {
      reports.remember(`pane-${pane}`, null, { session: win(50), weekly: null })
      // Re-posting keeps pane-1 recent while pane-0 ages out.
      reports.remember('pane-1', null, { session: win(100), weekly: null })
    }
    expect(reports.hasChanged('pane-0', null, 'session', win(7))).toBe(false)
    expect(reports.hasChanged('pane-1', null, 'session', win(7))).toBe(true)
  })

  it('does not treat a report from another account as a change', () => {
    const reports = new ClaudeLiveUsagePaneReports()
    reports.remember('pane-0', '/managed/account-a', { session: win(100), weekly: null })
    expect(reports.hasChanged('pane-0', '/managed/account-b', 'session', win(7))).toBe(false)
    expect(reports.hasChanged('pane-0', '/managed/account-a', 'session', win(7))).toBe(true)
  })
})
