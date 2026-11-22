import { describe, expect, it } from 'vitest'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const child = { rootSessionId: 'root', childSessionId: 'child', parentSessionId: 'root' }

describe('OpenCode child sessions', () => {
  it('ends a failed child with its error as the last message', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'root', dialect: OPENCODE_ACP_DIALECT })
    lane.openPrompt('prompt-1', 1)
    const report = (params: Record<string, unknown>, at: number): void => {
      lane.notification('opencode/session/child_update', { ...child, ...params }, at)
    }
    report({ type: 'status', status: 'created' }, 2)
    report({ type: 'status', status: 'running' }, 3)
    report(
      {
        type: 'status',
        status: 'failed',
        error: {
          type: 'provider.rate-limit',
          message: 'Rate limit reached;\ntry again.',
          status: 429
        }
      },
      4
    )
    expect(lane.subagents.drainEvidence().filter((e) => e.type === 'ended')).toEqual([
      expect.objectContaining({ outcome: 'failed', lastMessage: 'Rate limit reached; try again.' })
    ])
  })
})
