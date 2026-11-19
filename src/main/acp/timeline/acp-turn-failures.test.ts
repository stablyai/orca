import { describe, expect, it } from 'vitest'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'

function endedOutcomes(reportFailure: boolean) {
  const lane = new AcpTimelineTranslator({
    sessionId: 'session-1',
    dialect: {
      ...ANTIGRAVITY_ACP_DIALECT,
      notification: () =>
        reportFailure
          ? { disposition: 'map', failure: { stopReason: 'error', failureDetail: 'Denied.' } }
          : undefined
    }
  })
  lane.openPrompt('prompt-1', 1)
  lane.notification(
    'session/update',
    {
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Denied.' } }
    },
    2
  )
  return lane
    .promptResult('prompt-1', { stopReason: 'end_turn' }, 3)
    .flatMap((event) => (event.type === 'turn.end' ? [event.outcome] : []))
}

describe('ACP turn failures', () => {
  it('fails an end_turn turn that already reported a mapped failure', () => {
    expect(endedOutcomes(true)).toEqual(['failure'])
  })

  it('keeps an end_turn turn without a reported failure successful', () => {
    expect(endedOutcomes(false)).toEqual(['success'])
  })
})
