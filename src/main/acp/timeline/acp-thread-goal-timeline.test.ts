import { describe, expect, it } from 'vitest'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'
import { readAcpFixture } from './testing/acp-timeline-fixture.test-support'

describe('Grok goal rows', () => {
  it('journals a recorded set, Stop, resume, Stop and clear as goal transitions', async () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    const rows = (await readAcpFixture('grok-v1.0.77-goal-lifecycle')).flatMap((frame, index) =>
      frame.message.method
        ? lane
            .notification(frame.message.method, frame.message.params, 1_000 + index)
            .flatMap((event) =>
              event.type === 'item.update' && event.body.kind === 'status' && event.body.threadGoal
                ? [
                    event.body.threadGoal.state === 'set'
                      ? [
                          event.item,
                          event.body.threadGoal.goal.status,
                          event.body.threadGoal.goal.timeUsedSeconds
                        ]
                      : [event.item.split(':')[0], 'cleared']
                  ]
                : []
            )
        : []
    )
    const goal = 'goal:1f63c3c5-118f-45b1-80d4-3278199b2dc6'
    expect(rows).toEqual([
      [goal, 'active', 0],
      [goal, 'paused', 44],
      [goal, 'active', 44],
      [goal, 'paused', 74],
      ['goal-cleared', 'cleared']
    ])
  })
})
