import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import { reportAutomationScheduleDrift } from './schedule-drift-report'

const makeAutomation = (name: string, rrule: string): Automation => ({
  id: `id-${name}`,
  name,
  prompt: 'Check the repo',
  precheck: null,
  agentId: 'claude',
  projectId: 'r1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'wt1',
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule,
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 0,
  updatedAt: 0
})

describe('automation schedule drift report', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names each affected record and which way it moved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const count = reportAutomationScheduleDrift([
      makeAutomation('Quarter-hourly sweep', '5/15 * * * *'),
      makeAutomation('Odd days and Mondays', '0 9 */2 * 1'),
      makeAutomation('Weekday standup', '30 9 * * 1-5')
    ])

    expect(count).toBe(2)
    const lines = warn.mock.calls.map((call) => String(call[0]))
    expect(lines[0]).toContain('2 saved schedule(s) changed meaning')
    expect(
      lines.some((l) => l.includes('Quarter-hourly sweep') && l.includes('now runs more'))
    ).toBe(true)
    expect(
      lines.some((l) => l.includes('Odd days and Mondays') && l.includes('now runs fewer'))
    ).toBe(true)
    // The untouched preset must not be named, or the report trains the reader to skip it.
    expect(lines.some((l) => l.includes('Weekday standup'))).toBe(false)
  })

  it('says nothing when no saved schedule drifted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(reportAutomationScheduleDrift([makeAutomation('Hourly', '0 * * * *')])).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })
})
