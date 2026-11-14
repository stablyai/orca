import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionStatusEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { agentSessionAttentionNews } from '../../../../../shared/agent-session/agent-session-attention'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig'

it('publishes an async attention edge during execution and retains status for reconnecting readers', async () => {
  const rig = await createRestTestRig()
  try {
    await foundRestTestChat(rig)
    const events: AgentSessionTurnCompletionEvent[] = []
    rig.host.subscribeTurnCompletions({
      id: 'desktop-and-mobile',
      includePrompts: true,
      emit: (event) => events.push(event)
    })
    const provider = rig.adapter.acquire.mock.calls.at(-1)![0].events!
    const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'async-turn', ordinal: 0 }
    provider.appendItem(
      turn,
      { kind: 'turn', turnId: 'async-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    provider.appendItem(
      { ...turn, ordinal: 1 },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [
          {
            type: 'tool-call',
            name: 'request_user_input_async',
            callId: 'question-call',
            input: { questions: [{ title: 'Deploy?', options: ['Yes', 'No'] }] }
          }
        ]
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    expect(rig.host.readStatusSummary(SESSION)).toMatchObject({ status: 'attention' })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'prompt',
        prompt: expect.objectContaining({ sessionId: SESSION })
      })
    ])
    expect(
      events.flatMap((event) => (event.type === 'end' ? [] : [agentSessionAttentionNews(event)]))
    ).toEqual([{ agentState: 'blocked' }])

    provider.appendItem(
      { ...turn, ordinal: 2 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Independent work' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    const reconnected: AgentSessionStatusEvent[] = []
    const unsubscribe = rig.host.subscribeStatus({
      id: 'reconnected',
      emit: (event) => reconnected.push(event)
    })
    expect(reconnected).toContainEqual(
      expect.objectContaining({
        type: 'snapshot',
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: SESSION, status: 'attention' })
        ])
      })
    )
    unsubscribe()
    expect(events).toHaveLength(1)

    const answer = restTestSend(
      '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"question-call\\",0]","answer":"Yes"}]</send_user_message_question_reply>',
      rig.store.getRecord(SESSION)!.lease.runtimeFence
    )
    expect(await rig.host.send(REST_TEST_CALLER, answer)).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(rig.host.readStatusSummary(SESSION)).toMatchObject({ status: 'working' })
    )
    expect(events).toHaveLength(1)
  } finally {
    await rig.dispose()
  }
})
