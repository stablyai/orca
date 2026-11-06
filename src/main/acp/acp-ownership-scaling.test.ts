import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENERIC_ACP_DIALECT } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(() => vi.restoreAllMocks())

function permission(lane: AcpTimelineTranslator, callId: string) {
  return lane.request(
    'session/request_permission',
    {
      sessionId: 'session-1',
      toolCall: { toolCallId: callId },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    },
    callId
  ).events
}

describe('ACP ownership resource contract', () => {
  it('keeps uncapped live populations through older publication callbacks', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GENERIC_ACP_DIALECT })
    lane.openPrompt('first', 1)
    for (let index = 0; index < 160; index += 1) {
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `t-${index}`,
            title: 'Read',
            status: 'in_progress'
          }
        },
        2
      )
    }
    const oldPublication = lane.publication()
    lane.promptResult('first', { stopReason: 'end_turn' }, 3)
    lane.openPrompt('second', 4)
    lane.promptResult('second', { stopReason: 'end_turn' }, 5)
    oldPublication?.()
    expect(permission(lane, 't-0')[0]).toMatchObject({ join: { turn: 'prompt:first' } })
    lane.publication()?.()
    expect(permission(lane, 't-0')[0]).not.toHaveProperty('join.turn')
    lane.openPrompt('pending', 6)
    lane.promptResult('pending', { stopReason: 'end_turn' }, 7)
    const delayed = lane.publication()
    expect(delayed).toBeTypeOf('function')
    lane.dispose()
    delayed?.()
  })
})
