import { describe, expect, it } from 'vitest'
import { ClaudeLiveUsageSessionReports } from './claude-live-usage-session-reports'
import {
  readClaudeStatusLineForm,
  readClaudeStatusLineRateLimits
} from '../../../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'

describe('ClaudeLiveUsageSessionReports', () => {
  it('bounds reset-adoption tracking to 64 sessions and prunes expired reset windows', () => {
    const reports = new ClaudeLiveUsageSessionReports()
    const now = 1_700_000_000_000
    const resetsAt = now + 60 * 60 * 1000
    const high = { usedPercent: 80, windowMinutes: 300, resetsAt, resetDescription: null }
    const low = { usedPercent: 5, windowMinutes: 300, resetsAt, resetDescription: null }

    reports.remember('session-0', null, { session: high, weekly: null }, now)
    expect(reports.recordReset('session-0', null, 'session', low, now)).toBe(true)
    reports.remember('session-0', null, { session: low, weekly: null }, now)

    for (let i = 1; i <= 500; i += 1) {
      const id = `session-${i}`
      reports.remember(id, null, { session: high, weekly: null }, now)
      expect(reports.recordReset(id, null, 'session', low, now)).toBe(false)
      reports.remember(id, null, { session: low, weekly: null }, now)
    }

    const counts = reports.getTrackedCounts()
    expect(counts.sessions).toBeLessThanOrEqual(64)
    expect(counts.maxResetAdopters).toBeLessThanOrEqual(64)

    // Once the reset window expires, isResetWindow prunes the entry.
    expect(reports.isResetWindow(null, 'session', low, resetsAt + 1)).toBe(false)
    expect(reports.getTrackedCounts().resetWindows).toBe(0)
  })

  it('marks only known-repeating sessions as unchanged so unseen and sessionless reports are not frozen after a reset', () => {
    const reports = new ClaudeLiveUsageSessionReports()
    const now = 1_700_000_000_000
    const resetsAt = now + 60 * 60 * 1000
    const stale = { usedPercent: 80, windowMinutes: 300, resetsAt, resetDescription: null }
    const postReset = { usedPercent: 25, windowMinutes: 300, resetsAt, resetDescription: null }

    reports.remember('idle-pane', null, { session: stale, weekly: null }, now)

    expect(reports.isUnchanged('idle-pane', null, 'session', stale)).toBe(true)
    expect(reports.isUnchanged('idle-pane', null, 'session', postReset)).toBe(false)
    expect(reports.isUnchanged('new-pane', null, 'session', postReset)).toBe(false)
    expect(reports.isUnchanged(null, null, 'session', postReset)).toBe(false)
  })

  it('reads paneKey from statusline forms so one resumed session_id across two panes does not fabricate a reset', () => {
    const now = 1_700_000_000_000
    const resetsAtSec = Math.floor((now + 60 * 60 * 1000) / 1000)
    const formA = readClaudeStatusLineForm({
      paneKey: 'tab-1:leaf-a',
      configDir: '',
      payload: JSON.stringify({
        session_id: 'shared-conv',
        rate_limits: { five_hour: { used_percentage: 50, resets_at: resetsAtSec } }
      })
    })
    const formB = readClaudeStatusLineForm({
      paneKey: 'tab-2:leaf-b',
      configDir: '',
      payload: JSON.stringify({
        session_id: 'shared-conv',
        rate_limits: { five_hour: { used_percentage: 20, resets_at: resetsAtSec } }
      })
    })
    const eventA = readClaudeStatusLineRateLimits(formA!)
    const eventB = readClaudeStatusLineRateLimits(formB!)
    expect(eventA?.paneKey).toBe('tab-1:leaf-a')
    expect(eventB?.paneKey).toBe('tab-2:leaf-b')

    const keyA = JSON.stringify([eventA!.paneKey, eventA!.sessionId])
    const keyB = JSON.stringify([eventB!.paneKey, eventB!.sessionId])
    const reports = new ClaudeLiveUsageSessionReports()
    const winA = {
      usedPercent: 50,
      windowMinutes: 300,
      resetsAt: resetsAtSec * 1000,
      resetDescription: null
    }
    const winB = {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: resetsAtSec * 1000,
      resetDescription: null
    }

    reports.remember(keyA, null, { session: winA, weekly: null }, now)
    expect(reports.recordReset(keyB, null, 'session', winB, now)).toBe(false)
  })
})
