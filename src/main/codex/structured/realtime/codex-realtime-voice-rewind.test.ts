import { expect, it } from 'vitest'
import type { AgentSessionVoiceEvent } from '../../../../shared/agent-session/agent-session-voice-conversation'
import {
  THREAD_ID,
  acquired,
  fakeCodex
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve()
  }
}

it('drops what a voice call heard once the chat is rewound, so undone speech never returns', async () => {
  const codex = fakeCodex({
    'thread/timeline/list': () => {
      throw new Error('thread/timeline/list is not supported yet')
    },
    'thread/turns/list': () => ({
      data: [
        {
          id: 'kept',
          startedAt: 1,
          items: [
            { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Plan the cache' }] },
            { type: 'agentMessage', id: 'a1', text: 'Use LRU.', phase: 'final_answer' }
          ]
        }
      ]
    })
  })
  const adapter = await acquired(codex)
  const connection = codex.connections.at(-1)
  const notify = (method: string, params: Record<string, unknown>) =>
    connection?.handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
  const call = () => {
    const events: AgentSessionVoiceEvent[] = []
    adapter.startVoiceConversation({
      sessionId: 'session-1',
      offerSdp: 'v=0 offer',
      emit: (event) => events.push(event)
    })
    return events
  }
  const startedWith = () =>
    connection?.calls.findLast((request) => request.method === 'thread/realtime/start')?.params
      ?.initialItems

  const live = call()
  await settle()
  notify('thread/realtime/sdp', { sdp: 'v=0 answer' })
  notify('thread/realtime/item/completed', {
    item: { type: 'transcriptSegment', id: 's1', role: 'user', text: 'Drop the cache entirely' }
  })

  await adapter
    .prepareRewind({ sessionId: 'session-1', fence: 7, beforeTurnId: 'later' })
    .catch(() => undefined)
  expect(live.at(-1)).toEqual({ type: 'ended', reason: 'requested' })
  notify('thread/realtime/closed', { reason: 'requested' })

  const next = call()
  await settle()
  // The first call started with these same turns; only a second start proves the new seed.
  expect(next).toEqual([])
  expect(
    connection?.calls.filter((request) => request.method === 'thread/realtime/start')
  ).toHaveLength(2)
  expect(startedWith()).toEqual([
    { role: 'user', text: 'Plan the cache' },
    { role: 'assistant', text: 'Use LRU.' }
  ])
})
