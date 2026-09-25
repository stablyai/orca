// A chat whose main agent had finished while its subagents still ran, across a restart.

import { expect, it, vi } from 'vitest'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

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

// The offer was admitted for the subagent's work; the continuation asks the agent to carry it on.
it('continues a chat whose subagent the restart stopped', async () => {
  const { host, dispatch } = await interruptedRestart('children')
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// The user opens the chat before choosing Resume: reading it starts nothing, so the offer stands.
it('still offers and continues a chat the user opened before resuming', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('children')
  const unsubscribe = await host.subscribe({ id: 'pane', sessionId: SESSION, emit: vi.fn() })
  await host.history({ sessionId: SESSION, direction: 'tail' })
  unsubscribe()
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.list()).toMatchObject([
    { sessionId: SESSION, activity: { tasks: [{ kind: 'agent', label: 'Review loop 4' }] } }
  ])
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})
