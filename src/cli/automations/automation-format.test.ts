import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import {
  formatAutomationList,
  formatAutomationShow,
  printAutomationResult
} from './automation-format'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-legacy',
    executionTargetType: 'ssh',
    executionTargetId: 'box-1',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('formatAutomationList and Show print event triggers', () => {
  const on: AutomationEventTrigger[] = [
    { id: 'on-1', source: 'slack', event: 'message', textContains: 'a b' }
  ]

  it('prints JSON with no placeholder schedule for an events-only automation only', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const response = <T>(result: T) => ({
      id: 'r',
      ok: true as const,
      result,
      _meta: { runtimeId: 'x' }
    })
    const eventOnly = automation({ ...EVENT_ONLY_SCHEDULE, on })
    const scheduled = automation({ id: 'auto-2' })
    printAutomationResult(
      response({ automations: [eventOnly, scheduled] }),
      true,
      formatAutomationList
    )
    printAutomationResult(response({ automation: eventOnly }), true, formatAutomationShow)
    const [listed, shown] = log.mock.calls.map(([text]) => JSON.parse(String(text)).result)
    expect(listed.automations[0]).toMatchObject({ rrule: null, dtstart: null, nextRunAt: null, on })
    expect(listed.automations[1]).toMatchObject({ rrule: scheduled.rrule, nextRunAt: 0 })
    expect(shown.automation).toMatchObject({ rrule: null, dtstart: null, nextRunAt: null })
    log.mockRestore()
  })
})
