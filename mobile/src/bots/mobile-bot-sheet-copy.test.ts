import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../src/shared/automation-event-triggers'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'
import {
  activityRowView,
  automationWhenText,
  botStatusFromDots,
  memberSourceLabel
} from './mobile-bot-sheet-copy'

function automation(overrides: Partial<BotAutomationView> = {}): BotAutomationView {
  return {
    id: 'a-1',
    name: 'Morning digest',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    dtstart: 0,
    rrule: 'FREQ=HOURLY;BYMINUTE=5',
    workspaceId: 'folder:home',
    ...overrides
  }
}

describe('activity rows', () => {
  it("draws the host's dot as it is", () => {
    const view = activityRowView({
      kind: 'worker',
      key: 'w',
      title: '',
      dot: 'permission',
      origin: { kind: 'chat' }
    })
    expect(view).toEqual({ title: 'Worker', detail: 'Started by your chat', dot: 'permission' })
  })

  it('words a run by its status, and leaves Done unsaid', () => {
    const run = { kind: 'run', key: 'r', automationName: 'Digest', dot: null, at: 0 } as const
    expect(activityRowView({ ...run, status: 'dispatch_failed' })).toMatchObject({
      title: 'Digest',
      detail: 'Run · Never · Failed',
      dot: 'failed'
    })
    expect(activityRowView({ ...run, status: 'completed' }).detail).toBe('Run · Never')
    // A status from a newer host keeps the row, with no status word.
    expect(activityRowView({ ...run, status: undefined })).toMatchObject({ dot: 'idle' })
  })
})

describe('automationWhenText', () => {
  it('names the event and says Paused for a disabled event-only automation', () => {
    expect(
      automationWhenText(
        automation({
          ...EVENT_ONLY_SCHEDULE,
          on: [{ id: 'r2', source: 'github', event: 'ci_failed' }]
        }),
        false
      )
    ).toBe('When CI fails · Paused')
  })
})

describe('botStatusFromDots', () => {
  it('puts anything waiting on you first, then anything running', () => {
    expect(botStatusFromDots(['working'], ['permission'], false)).toBe('permission')
    expect(botStatusFromDots(['idle'], ['monitoring'], false)).toBe('working')
    expect(botStatusFromDots(['done'], [], false)).toBe('active')
    expect(botStatusFromDots([], [], true)).toBe('inactive')
  })
})

describe('memberSourceLabel', () => {
  it('names a known service and passes a newer one through', () => {
    expect(memberSourceLabel({ id: 'u', name: 'Dana' })).toBe('Slack')
    expect(memberSourceLabel({ id: 'u', name: 'Dana', source: 'teams' })).toBe('teams')
  })
})
