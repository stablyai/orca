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

const KEPT = [
  { role: 'user', text: 'Plan the cache' },
  { role: 'assistant', text: 'Use LRU.' }
]

async function heardCall(
  revert: Promise<unknown> = Promise.resolve({ thread: { id: THREAD_ID } })
) {
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
    }),
    'thread/read': () => ({ thread: { id: THREAD_ID, status: { type: 'idle' } } }),
    'thread/revert': () => revert
  })
  const adapter = await acquired(codex)
  const connection = codex.connections.at(-1)
  const notify = (method: string, params: Record<string, unknown>) =>
    connection?.handlers.onNotification?.(method, { threadId: THREAD_ID, ...params })
  const call = () => {
    const events: AgentSessionVoiceEvent[] = []
    const handle = adapter.startVoiceConversation({
      sessionId: 'session-1',
      offerSdp: 'v=0 offer',
      emit: (event) => events.push(event)
    })
    return { events, handle }
  }
  const starts = () =>
    connection?.calls.filter((request) => request.method === 'thread/realtime/start') ?? []
  const live = call()
  await settle()
  notify('thread/realtime/sdp', { sdp: 'v=0 answer' })
  notify('thread/realtime/item/completed', {
    item: { type: 'transcriptSegment', id: 's1', role: 'user', text: 'Drop the cache entirely' }
  })
  return { adapter, connection, notify, call, starts, live }
}

it('refuses a voice call until the rewind settles, then starts without the undone speech', async () => {
  let reverted: (value: unknown) => void = () => {}
  const { adapter, notify, call, starts, live } = await heardCall(
    new Promise((resolve) => (reverted = resolve))
  )

  const rewound = adapter.rewind({ sessionId: 'session-1', fence: 7, beforeTurnId: 'undone' })
  await settle()
  expect(live.events.at(-1)).toEqual({ type: 'ended', reason: 'requested' })
  notify('thread/realtime/closed', { reason: 'requested' })

  const during = call()
  await settle()
  expect(during.events).toEqual([{ type: 'refused', reason: 'busy' }])
  expect(starts()).toHaveLength(1)

  reverted({ thread: { id: THREAD_ID } })
  await expect(rewound).resolves.toEqual({ ok: true })
  const next = call()
  await settle()
  expect(next.events).toEqual([])
  expect(starts()).toHaveLength(2)
  expect(starts().at(-1)?.params?.initialItems).toEqual(KEPT)
})

it('keeps the call and what it heard when Codex refuses to prepare the rewind', async () => {
  const { adapter, connection, notify, call, starts, live } = await heardCall()

  await expect(
    adapter.prepareRewind({ sessionId: 'session-1', fence: 8, beforeTurnId: 'kept' })
  ).resolves.toEqual({ ok: false, reason: 'invalid-target' })
  expect(live.events.some((event) => event.type === 'ended')).toBe(false)
  expect(connection?.calls.some((request) => request.method === 'thread/realtime/stop')).toBe(false)

  live.handle.stop()
  notify('thread/realtime/closed', { reason: 'requested' })
  call()
  await settle()
  expect(starts().at(-1)?.params?.initialItems).toEqual([
    ...KEPT,
    { role: 'user', text: 'Drop the cache entirely' }
  ])
})
