// An offer across the provider reattaching and rewriting the chat in its own words: a notice turn
// of its own, restated rows. None of it withdraws the offer or changes the message Resume sends.

import { expect, it } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../shared/agent-session-restart-continuation'
import { restartContinuationBody } from './structured-agent-session-restart-continuation'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

function resumedEvents(state: Awaited<ReturnType<typeof interruptedRestart>>) {
  // The latest acquisition: an earlier one may have been refused.
  const events = state.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  return events
}

// THE REPORTED REFUSAL: opening the chat reattached Claude, which opened a turn of its own to say
// the previous session did not finish, and closed it. The chat is still offered and Resume sends —
// including when the offer is a send that had not become a turn, where that closed notice turn is
// the newest turn in the journal.
it.each(['turn', 'submission'] as const)(
  'still offers and continues a %s offer after the provider opens and closes a notice turn',
  async (work) => {
    const state = await interruptedRestart(work, false)
    const { host, dispatch } = state
    await host.hold(SESSION, 'pane')
    const events = resumedEvents(state)
    const notice = { provider: 'codex', threadId: THREAD, turnId: 'notice-turn' } as const
    events.appendItem(
      { ...notice, ordinal: 1 },
      { kind: 'turn', turnId: 'notice-turn', state: 'running', userItemId: 'turn:notice-turn' }
    )
    events.appendItem(
      { ...notice, ordinal: 2 },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: "didn't finish before the previous session ended" }]
      }
    )
    events.appendItem(
      { ...notice, ordinal: 1 },
      { kind: 'turn', turnId: 'notice-turn', state: 'completed', userItemId: 'turn:notice-turn' }
    )
    await host.flushStreamedEvents(SESSION)

    expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
    expect(
      (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
    ).toMatchObject([{ outcome: 'continued' }])
    expect(dispatch).toHaveBeenCalledTimes(1)
    host.release(SESSION, 'pane')
  }
)

// A retry after the first attempt never reached the provider, with the rows restated in between:
// the body depends on the marker alone, so the ledger fingerprint stays the offer's.
it('sends the same continuation body on a retry after the provider restates its rows', async () => {
  const state = await interruptedRestart('children')
  const { host, acquire, dispatch, marker } = state
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toMatchObject([{ retryable: true }])

  await host.hold(SESSION, 'pane')
  resumedEvents(state).appendItem(
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
  const retried = await host.restartResume.continueAfterRestart([SESSION], 'retry')

  expect(retried.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(dispatch.mock.calls[0]?.[0].body).toEqual(restartContinuationBody(marker))
  host.release(SESSION, 'pane')
})

// A marker from a build that recorded only a working lead: no snapshot, so no activity to name,
// and the original wording.
it('offers and continues a marker with no snapshot', async () => {
  const { host, root, dispatch, marker } = await interruptedRestart('children')
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  const { activity: _activity, ...older } = marker
  await host.restartResume.dismiss([SESSION])
  await new AgentSessionRecoveryCapsule(root).record([older], NOW)

  const [offer] = await host.restartResume.list()
  expect(offer).toMatchObject({ sessionId: SESSION })
  expect(offer).not.toHaveProperty('activity')
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch.mock.calls[0]?.[0].body.blocks).toEqual([
    { type: 'text', text: AGENT_SESSION_RESTART_CONTINUATION_MESSAGE }
  ])
})
