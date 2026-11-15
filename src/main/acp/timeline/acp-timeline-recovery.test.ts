import { describe, expect, it } from 'vitest'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { GROK_ACP_DIALECT } from '../acp-dialects/grok-dialect'

describe('ACP reviewed traffic and recovery', () => {
  it('retains full late tool updates through more than 128 concurrent tools', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    const big = 'x"\\'.repeat(12000)
    for (let index = 0; index < 160; index += 1) {
      expect(() =>
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `t${index}`,
              title: 'Write',
              status: 'in_progress',
              rawInput: { content: big },
              rawOutput: big
            }
          },
          index
        )
      ).not.toThrow()
    }
    for (let index = 0; index < 160; index += 1) {
      expect(
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `t${index}`,
              status: 'completed'
            }
          },
          50 + index
        )
      ).toMatchObject([
        {
          type: 'item.close',
          body: {
            state: 'completed',
            name: 'Write',
            input: { content: big },
            output: { head: big, truncated: false }
          }
        }
      ])
    }
  })
})
