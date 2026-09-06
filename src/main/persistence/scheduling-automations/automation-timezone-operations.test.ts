import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createAutomation,
  updateAutomation,
  type AutomationDefinitionOperations
} from './automation-definition-operations'
import {
  advanceAutomationNextRun,
  getLatestAutomationOccurrence
} from './automation-schedule-operations'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('persisted automation timezone', () => {
  it('uses the timezone for create, timezone-only update, advance and catch-up', () => {
    vi.stubEnv('TZ', 'UTC')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T00:00:00Z'))
    const operations: AutomationDefinitionOperations = {
      state: {
        repos: [{ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 }],
        automations: [],
        projectHostSetups: [],
        worktreeMeta: {}
      } as unknown as PersistedState,
      storageAuthority: 'runtime',
      flush: vi.fn(),
      recordCreated: vi.fn()
    }
    const automation = createAutomation(operations, {
      name: 'Morning review',
      prompt: 'Review',
      agentId: 'codex',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'Asia/Shanghai',
      rrule: '0 9 * * *',
      dtstart: Date.parse('2026-09-01T00:00:00Z')
    })
    expect(automation.nextRunAt).toBe(Date.parse('2026-09-06T01:00:00Z'))
    const updated = updateAutomation(operations, automation.id, { timezone: 'America/New_York' })
    expect(updated.nextRunAt).toBe(Date.parse('2026-09-06T13:00:00Z'))
    const next = advanceAutomationNextRun(
      operations.state,
      operations.flush,
      automation.id,
      updated.nextRunAt
    )
    expect(next.nextRunAt).toBe(Date.parse('2026-09-07T13:00:00Z'))
    expect(getLatestAutomationOccurrence(next, Date.parse('2026-09-06T14:00:00Z'))).toBe(
      updated.nextRunAt
    )
    expect(() =>
      updateAutomation(operations, automation.id, { timezone: 'Invalid/Timezone' })
    ).toThrow()
    expect(operations.state.automations[0].timezone).toBe('America/New_York')
  })
})
