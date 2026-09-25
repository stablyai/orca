// A chat whose main agent had finished while its subagents still ran, across a restart.

import { expect, it, vi } from 'vitest'
import {
  interruptedRestart,
  startAgent
} from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

// What the user hit: the lead had finished, its subagent had not. The offer names the subagent
// from the roster snapshot taken BEFORE the child stopped — the close that follows settles the
// row as unverifiable, and that settlement must not erase the description.
it('offers a chat whose subagent the restart stopped, named from the stop-time snapshot', async () => {
  const { host, marker } = await interruptedRestart('children')
  expect(marker?.work).toEqual({ kind: 'turn', id: 'settled-turn' })
  expect(await host.restartResume.list()).toMatchObject([
    {
      sessionId: SESSION,
      activity: { state: 'done', prompts: [], tasks: [{ kind: 'agent', label: 'Review loop 4' }] }
    }
  ])
})

// On resume the provider restates what it lost in its own words, rewriting the row before the
// continuation is dispatched. What the offer was admitted for still stands.
it('continues a stopped subagent after the provider restates its row', async () => {
  const state = await interruptedRestart('children')
  const { host, acquire, dispatch } = state
  await startAgent(state)
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  const admit = vi.spyOn(host.deps.store, 'admitMutationOperation')
  admit.mockImplementationOnce(async (input) => {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'settled-turn', ordinal: 2 },
      {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'settled-turn',
            agents: [{ id: 'child-1', label: 'Review loop 4', state: 'completed' }]
          }
        ]
      }
    )
    await host.flushStreamedEvents(SESSION)
    admit.mockRestore()
    return host.deps.store.admitMutationOperation(input)
  })
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// The user opens the chat before choosing Resume, and the reattached provider restates its row.
it('still offers and continues a chat the user opened before resuming', async () => {
  const state = await interruptedRestart('children')
  const { host, acquire, dispatch } = state
  await startAgent(state)
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'settled-turn', ordinal: 2 },
    {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'settled-turn',
          agents: [{ id: 'child-1', label: 'Review loop 4', state: 'completed' }]
        }
      ]
    }
  )
  await host.flushStreamedEvents(SESSION)
  expect(await host.restartResume.list()).toMatchObject([
    { sessionId: SESSION, activity: { tasks: [{ kind: 'agent', label: 'Review loop 4' }] } }
  ])
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})
