import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK_ACP_DIALECT } from '../../acp-dialects/grok-dialect'
import { GENERIC_ACP_DIALECT, type AcpDialect } from '../../acp-dialects/acp-dialect'
import { acpSubagentRecords } from '../testing/acp-structured-child-work.test-support'
import { PROVIDER_SESSION, replyChunk } from '../testing/acp-structured-adapter.test-support'
import { AcpTimelineTranslator } from '../../timeline/acp-timeline-translator'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

function translator(dialect: AcpDialect = GROK_ACP_DIALECT) {
  const lane = new AcpTimelineTranslator({ sessionId: PROVIDER_SESSION, dialect })
  const { promptId } = lane.openPrompt('parent', 100)
  lane.notification('session/update', replyChunk(promptId, 'Parent running'), 101)
  lane.notification(
    '_x.ai/session_notification',
    {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child',
        parent_prompt_id: promptId,
        description: 'Original label'
      }
    },
    102
  )
  const records = acpSubagentRecords()
  const host = () => records(lane.subagents.drainEvidence())
  host()
  const end = (
    reason: string,
    sessionId = 'child',
    meta = {},
    method = '_x.ai/session_notification'
  ) =>
    lane.notification(
      method,
      {
        sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'child-turn',
          stop_reason: reason,
          usage: { inputTokens: 99999 },
          elapsed_ms: 20
        },
        _meta: meta
      },
      120
    )
  return { lane, end, host, promptId }
}

describe('owned Grok child-session completion', () => {
  it('latches cancellation against conflicting child ends, parent reports and later working progress', () => {
    const f = translator()
    expect(f.end('cancelled')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'cancelled' }])
    expect(f.end('end_turn')).toEqual([])
    expect(
      f.lane.notification(
        '_x.ai/session_notification',
        {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'failed' }
        },
        121
      )
    ).toEqual([])
    const progress = f.lane.notification(
      '_x.ai/session_notification',
      {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'subagent_progress', subagent_id: 'child', tokens_used: 7 }
      },
      122
    )
    expect(progress).toEqual([])
    expect(f.host()).toMatchObject([
      { providerId: 'child', membership: 'settled', outcome: 'cancelled' }
    ])
  })

  it('drops child messages, turn starts and usage instead of opening a child turn in the parent', () => {
    const f = translator()
    for (const update of [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child text' } },
      { sessionUpdate: 'response_completed', usage: { input_tokens: 99999 } },
      { sessionUpdate: 'turn_started', prompt_id: 'child-turn' }
    ]) {
      expect(
        f.lane.notification('_x.ai/session_notification', { sessionId: 'child', update }, 120)
      ).toEqual([])
    }
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.end('end_turn')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
  })

  it('ignores replay and loading even when a loading notice explicitly says it is live', () => {
    const f = translator()
    expect(f.end('cancelled', 'child', { isReplay: true })).toEqual([])
    f.lane.promptResult('parent', { stopReason: 'end_turn' }, 110)
    f.lane.beginLoad()
    expect(f.end('cancelled')).toEqual([])
    expect(f.end('cancelled', 'child', { isReplay: false })).toEqual([])
    f.lane.finishLoad()
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.end('end_turn')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
    f.lane.dispose()
    expect(f.end('cancelled')).toEqual([])
  })

  it('keeps the foreign-session fence for another dialect even when its parent reports subagents', () => {
    const f = translator({
      ...GENERIC_ACP_DIALECT,
      notification: GROK_ACP_DIALECT.notification
    })
    expect(f.end('cancelled')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
  })
})
