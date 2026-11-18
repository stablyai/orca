import { describe, expect, it } from 'vitest'
import { activityRowView, botStatusFromDots } from './mobile-bot-sheet-copy'

describe('activity rows', () => {
  it("draws the host's dot as it is", () => {
    const view = activityRowView({
      kind: 'worker',
      key: 'w',
      title: '',
      dot: 'permission',
      origin: { kind: 'chat' }
    })
    expect(view.dot).toBe('permission')
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

describe('botStatusFromDots', () => {
  it('puts anything waiting on you first, then anything running', () => {
    expect(botStatusFromDots(['working'], ['permission'], false)).toBe('permission')
    expect(botStatusFromDots(['idle'], ['monitoring'], false)).toBe('working')
    expect(botStatusFromDots(['done'], [], false)).toBe('active')
    expect(botStatusFromDots([], [], true)).toBe('inactive')
  })
})
