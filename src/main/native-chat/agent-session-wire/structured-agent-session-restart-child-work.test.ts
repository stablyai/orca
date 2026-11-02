import { expect, it, vi } from 'vitest'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

// Capture names before shutdown settlement marks child work unverifiable.
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

it('continues a chat whose subagent the restart stopped', async () => {
  const { host, dispatch } = await interruptedRestart('children')
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

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
