import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../src/shared/automation-event-triggers'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'
import {
  activityOriginLabel,
  activityRowView,
  automationWhenText,
  automationWontFireNote,
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
  it('says what started a worker, as the desktop does', () => {
    expect(activityOriginLabel({ kind: 'chat' })).toBe('Started by your chat')
    expect(activityOriginLabel({ kind: 'thread', source: 'slack' })).toBe(
      'Started by a Slack thread'
    )
    expect(activityOriginLabel({ kind: 'automation', name: 'Digest' })).toBe(
      'Started by automation Digest'
    )
    expect(activityOriginLabel(null)).toBeNull()
  })

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

  it('names a thread by its service', () => {
    expect(
      activityRowView({ kind: 'thread', key: 't', title: '', source: 'linear', dot: 'done' })
    ).toEqual({ title: 'Linear thread', detail: 'Linear thread', dot: 'done' })
  })
})

describe('automationWhenText', () => {
  it('words the schedule, then each event, and says Paused when off', () => {
    expect(automationWhenText(automation(), true)).toBe('Hourly at :05')
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

describe('automationWontFireNote', () => {
  const bot = { id: 'b1', name: 'Atlas', slack: null, github: null, linear: null }
  const on = [{ id: 'r1', source: 'slack', event: 'mentioned' }] as const

  it('says the desktop note when the bot lacks the connector', () => {
    expect(
      automationWontFireNote(
        automation({ ...EVENT_ONLY_SCHEDULE, bot: { botId: 'b1' }, on: [...on] }),
        bot
      )
    ).toBe('Won’t run: needs the Slack connector')
    expect(automationWontFireNote(automation({ bot: { botId: 'b1' }, on: [...on] }), bot)).toBe(
      'Runs on its schedule only: needs the Slack connector'
    )
    expect(automationWontFireNote(automation({ bot: { botId: 'b1' } }), bot)).toBeNull()
  })
})
