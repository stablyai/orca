import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { latestStructuredAgentSessionUserItem } from '../../../shared/structured-agent-session-projection'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import {
  interruptedRestart,
  statusNotes
} from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

// Which outcomes of a restart action become a failure the user is shown, and what retires one.

afterEach(() => vi.restoreAllMocks())

function providerEvents(acquire: Awaited<ReturnType<typeof interruptedRestart>>['acquire']) {
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  return events
}

// The reported case: after the reattach the provider replays a queued message, which the chat
// journals as a newer user turn, so the continuation is refused just before dispatch.
it('files a continuation superseded by a replayed message, lists it and says so in the chat', async () => {
  const { host, acquire, dispatch, root } = await interruptedRestart()
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const events = providerEvents(acquire)
  // The replay lands after the reattach and just before the continuation is accepted, which is
  // where a send asks whether its offer still stands.
  const send = host.send
  vi.spyOn(host, 'send').mockImplementationOnce(async (caller, params) => {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'replayed-turn', ordinal: 1 },
      hostTestMessage('A queued notification the provider replayed')
    )
    await host.flushStreamedEvents(SESSION)
    return send(caller, params)
  })

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(dispatch).not.toHaveBeenCalled()
  expect(result.resumed).toMatchObject([
    { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
  ])
  const failure = {
    sessionId: SESSION,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded'
  }
  expect(result.failed).toMatchObject([failure])
  expect(await host.restartResume.listFailures()).toMatchObject([failure])
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toHaveLength(1)
  expect(statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  host.release(SESSION, 'pane')
})

// Nothing was attempted and nothing is owed: the user moved on between listing and acting.
it('files nothing for a chat the user moved on in before its attempt, and spends the offer', async () => {
  const { host, acquire, root } = await interruptedRestart()
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const events = providerEvents(acquire)
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run').mockImplementationOnce(
    async function (this, ...args) {
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'newer-turn', ordinal: 1 },
        hostTestMessage('A newer task from another client')
      )
      await host.flushStreamedEvents(SESSION)
      return admit.apply(this, args)
    }
  )

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.resumed).toMatchObject([{ reason: 'agent_session_resume_not_eligible' }])
  expect(result.failed).toEqual([])
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect(await capsule.list(NOW)).toEqual([])
  expect(statusNotes(host)).toEqual([])
  host.release(SESSION, 'pane')
})

it.each(['resume', 'continueAfterRestart'] as const)(
  'says so in the chat when the reattach itself fails (%s)',
  async (action) => {
    const { host, acquire } = await interruptedRestart()
    await host.restartResume.list()
    acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))

    await host.restartResume[action]([SESSION], 'modal')

    expect(await host.restartResume.listFailures()).toMatchObject([
      { sessionId: SESSION, outcome: 'refused' }
    ])
    // The fix depends on why it failed, which the dialog explains; "send a message" would not work.
    expect(statusNotes(host)).toEqual([
      { text: AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE, tone: 'error' }
    ])
  }
)

/** A continuation the provider accepted whose settlement could not be written: filed unconfirmed. */
async function unconfirmedContinuation() {
  const state = await interruptedRestart()
  const { host, store } = state
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const settle = store.recordOperationOutcome.bind(store)
  vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
    if (input.outcome.status === 'succeeded') {
      throw new Error('operation outcome could not be persisted')
    }
    return settle(input)
  })
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
  expect(statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
    tone: 'warning'
  })
  const continuation = host.journalSnapshot(SESSION).submissions.at(-1)
  const providerItemId = continuation?.providerItemId
  if (!continuation || !providerItemId) {
    throw new Error('missing accepted continuation')
  }
  return { ...state, continuation, providerItemId, events: providerEvents(state.acquire) }
}

// The warning asked the user to check the agent's reply; a turn opened by the continuation's own
// message is that reply starting, however the provider names the message.
it.each(['submission key', 'provider key'] as const)(
  'retires an unconfirmed failure once the continuation opens a turn (%s)',
  async (naming) => {
    const { host, root, continuation, providerItemId, events } = await unconfirmedContinuation()
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'continued-turn', ordinal: 1 },
      {
        kind: 'turn',
        turnId: 'continued-turn',
        state: 'running',
        userItemId:
          naming === 'submission key'
            ? agentJournalSubmissionKey(continuation.clientMessageId)
            : providerItemId
      },
      { lifecycle: true }
    )
    await host.flushStreamedEvents(SESSION)

    expect(await host.restartResume.listFailures()).toEqual([])
    await vi.waitFor(async () => {
      expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
    })
    host.release(SESSION, 'pane')
  }
)

it('keeps an unconfirmed failure while the newest turn is not the continuation’s', async () => {
  const { host, events } = await unconfirmedContinuation()
  // Provider output opened this turn, keyed by its own row rather than by any user message.
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'provider-turn', ordinal: 1 },
    { kind: 'turn', turnId: 'provider-turn', state: 'running', userItemId: 'provider-turn-row' },
    { lifecycle: true }
  )
  await host.flushStreamedEvents(SESSION)

  expect(await host.restartResume.listFailures()).toMatchObject([{ outcome: 'unconfirmed' }])
  host.release(SESSION, 'pane')
})

// Nothing journaled the continuation, so the newest user message is still the interrupted one and
// the turn it opened is the interrupted work reporting in, not the agent carrying on.
it('keeps an unconfirmed failure whose continuation was never journaled while the interrupted turn runs', async () => {
  const { host, acquire, store, marker } = await interruptedRestart('submission', false)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const events = providerEvents(acquire)
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 1 },
    hostTestMessage('Perform the original task')
  )
  await host.flushStreamedEvents(SESSION)
  // A send that throws before recording anything cannot be proven undelivered.
  vi.spyOn(store, 'admitMutationOperation').mockRejectedValueOnce(new Error('store unavailable'))
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
  const submissions = host.journalSnapshot(SESSION).submissions
  const original = submissions[0]?.providerItemId
  if (submissions.length !== 1 || !original) {
    throw new Error('expected only the original submission, accepted by the provider')
  }
  expect(latestStructuredAgentSessionUserItem(host.journalSnapshot(SESSION).items)?.itemId).toBe(
    marker?.latestUserItemId
  )

  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 2 },
    { kind: 'turn', turnId: 'original-turn', state: 'running', userItemId: original },
    { lifecycle: true }
  )
  await host.flushStreamedEvents(SESSION)

  expect(await host.restartResume.listFailures()).toMatchObject([{ outcome: 'unconfirmed' }])
  host.release(SESSION, 'pane')
})
