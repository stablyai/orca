import { mkdir, rm, writeFile } from 'node:fs/promises'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { pendingApproval } from './structured-agent-session-restart-resume-test-harness'
import { restartContinuationEnvelope } from './structured-agent-session-restart-continuation'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from './structured-agent-session-restart-resume-wiring'
import {
  GRACE,
  interruptedRestart,
  statusNotes,
  supersededRefusal
} from './structured-agent-session-restart-interruption-test-harness'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.useRealTimers())

it('publishes continuation attribution to the subscribed chat without another provider event', async () => {
  const { host } = await interruptedRestart()
  await host.restartResume.list()
  const emit = vi.fn()
  const unsubscribe = host.subscribe({ id: 'pane', sessionId: SESSION, emit })
  try {
    expect(
      (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
    ).toMatchObject([{ outcome: 'continued' }])
    expect(JSON.stringify(emit.mock.calls)).toContain(AGENT_SESSION_RESTART_CONTINUATION_NOTE)
  } finally {
    unsubscribe()
  }
})

it('reports a failed attribution note without an installed error sink or private details', async () => {
  const { host } = await interruptedRestart()
  const append = AgentSessionJournal.prototype.appendItem
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const write = vi.spyOn(AgentSessionJournal.prototype, 'appendItem').mockImplementation(function (
    this: AgentSessionJournal,
    ...args
  ) {
    if (args[1].kind === 'status' && args[1].text === AGENT_SESSION_RESTART_CONTINUATION_NOTE) {
      return Promise.reject(new Error('private recovery payload at /private/account/session.json'))
    }
    return append.apply(this, args)
  })
  try {
    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(result.continued).toMatchObject([{ outcome: 'continued' }])
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[structured-agent-session] restart continuation attribution failed'
    )
  } finally {
    write.mockRestore()
    warning.mockRestore()
  }
})

it.each(['turn', 'submission'] as const)(
  'does not continue a marked %s after the user submits new work without a provider echo',
  async (work) => {
    const { host, dispatch } = await interruptedRestart(work, false)
    expect(await host.restartResume.list()).toHaveLength(1)
    await host.hold(SESSION, 'pane')
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Stop the old task and do this instead')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(work === 'turn' ? 1 : 2)
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
  }
)

it('preserves the offer when the original submission receives its provider echo', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('submission', false)
  expect(await host.restartResume.list()).toHaveLength(1)
  await host.hold(SESSION, 'pane')
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 1 },
    hostTestMessage('Perform the original task')
  )
  await host.flushStreamedEvents(SESSION)
  expect(host.journalSnapshot(SESSION).submissions[0]?.dispatchState).toBe('accepted')
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
  host.release(SESSION, 'pane')
  expect(host.isHeld(SESSION)).toBe(false)
})

// Teardown judged the chat working, and only the user moving on withdraws that. A send the
// provider proves it never received is still the chat Orca stopped; the continuation asks the agent
// to check what finished rather than refusing.
it('still continues a chat whose last send acquisition proves was never delivered', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('submission')
  expect(await host.restartResume.list()).toHaveLength(1)
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(host.journalSnapshot(SESSION).submissions[0]).toMatchObject({
    dispatchState: 'rejected',
    reason: 'not_delivered'
  })
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(host.isHeld(SESSION)).toBe(false)
})

/** Holds the continuation at send admission while `during` runs, then lets it proceed. */
async function continueAcross(
  state: Awaited<ReturnType<typeof interruptedRestart>>,
  during: (events: NonNullable<ReturnType<typeof resumedEvents>>) => void
) {
  const { host, store } = state
  expect(await host.restartResume.list()).toHaveLength(1)
  await host.hold(SESSION, 'pane')
  const events = resumedEvents(state)
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  const admitting = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const admit = store.admitMutationOperation
  vi.spyOn(store, 'admitMutationOperation').mockImplementationOnce(async (input) => {
    admitting.resolve()
    await proceed.promise
    return admit(input)
  })
  const continuing = host.restartResume.continueAfterRestart([SESSION], 'modal')
  await admitting.promise
  during(events)
  await host.flushStreamedEvents(SESSION)
  proceed.resolve()
  return continuing
}

function resumedEvents(state: Awaited<ReturnType<typeof interruptedRestart>>) {
  return state.acquire.mock.calls[0]?.[0].events
}

it('refuses at send admission once the user has sent a newer message', async () => {
  const state = await interruptedRestart()
  const { host, dispatch } = state
  const result = await continueAcross(state, (events) =>
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'newer-turn', ordinal: 1 },
      hostTestMessage('A newer task from another client')
    )
  )
  expect(result.resumed).toMatchObject([
    { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
  ])
  expect(dispatch).not.toHaveBeenCalled()
  // Refused where it would have been accepted, so the chat records no continuation at all.
  expect(host.journalSnapshot(SESSION).submissions).toEqual([])
  host.release(SESSION, 'pane')
  expect(host.isHeld(SESSION)).toBe(false)
})

// Claude opens a turn of its own on reattach to say the last session did not finish. Resume is
// pressed while that turn still runs: the continuation is sent and the provider queues it.
it('sends the continuation while a turn the provider opened is still running', async () => {
  const state = await interruptedRestart()
  const { host, dispatch } = state
  const result = await continueAcross(state, (events) =>
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'notice-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'notice-turn', state: 'running' }
    )
  )
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
  host.release(SESSION, 'pane')
})

// The send the user made just before quitting, after an earlier exchange had finished. Neither
// that finished turn nor the provider completing the send's own turn after the restart withdraws it.
it('offers and continues a send made after an earlier completed turn', async () => {
  const state = await interruptedRestart('send-after-reply', false)
  const { host, dispatch, marker } = state
  expect(marker?.work.kind).toBe('submission')
  const result = await continueAcross(state, (events) =>
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'original-turn', state: 'completed' }
    )
  )
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
  host.release(SESSION, 'pane')
})

it.each([false, true])(
  'refuses a queued newer message before dispatch even if later settlement fails: %s',
  async (settlementFails) => {
    const { host, store, acquire, dispatch } = await interruptedRestart('submission', false)
    expect(await host.restartResume.list()).toHaveLength(1)
    await host.hold(SESSION, 'pane')
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing resumed provider event sink')
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settle = store.recordOperationOutcome.bind(store)
    let admitted = false
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (admitted) {
        if (settlementFails) {
          throw new Error('operation outcome could not be persisted')
        }
        return settle(input)
      }
      await settle(input)
      admitted = true
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 2 },
        { kind: 'status', text: 'Provider finished its last action' }
      )
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 1 },
        hostTestMessage('A newer task from another client'),
        { lifecycle: true }
      )
      // Journaled before the continuation's acceptance asks whether its offer still stands.
      await host.flushStreamedEvents(SESSION)
    })

    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

    expect(result.continued).toMatchObject([
      { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
    ])
    expect(dispatch).not.toHaveBeenCalled()
    // Refused before acceptance: only the interrupted send is in the journal.
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(1)
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
    // The offer is spent, but the refusal is kept as a durable failure: a retry finds it, and the
    // superseded chat is still not eligible, so nothing runs and the record stays for the user.
    expect(await host.restartResume.continueAfterRestart([SESSION], 'retry')).toMatchObject({
      resumed: [],
      continued: [],
      sessions: [],
      failed: [
        { sessionId: SESSION, outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
      ]
    })
    expect(dispatch).not.toHaveBeenCalled()
    if (settlementFails) {
      expect(store.recordOperationOutcome).toHaveBeenCalledOnce()
      expect(warning).not.toHaveBeenCalled()
    }
    warning.mockRestore()
  }
)

// What the provider says after reattaching does not re-judge the offer.
it.each(['completed', 'approval', 'question'] as const)(
  'continues past provider %s evidence accepted while recording the continuation',
  async (event) => {
    const { host, acquire, dispatch } = await interruptedRestart()
    await host.restartResume.list()
    await host.hold(SESSION, 'pane')
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing resumed provider event sink')
    }
    const append = AgentSessionJournal.prototype.appendSubmission
    const writing = vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission')
    writing.mockImplementationOnce(async function (this: AgentSessionJournal, input) {
      const cursor = await append.call(this, input)
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal: 1 },
        event === 'completed'
          ? { kind: 'turn', turnId: 'interrupted-turn', state: 'completed' }
          : { ...pendingApproval().body, question: 'Which action?', kind: event },
        { lifecycle: true }
      )
      return cursor
    })
    try {
      const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
      expect(result.continued).toMatchObject([{ outcome: 'continued' }])
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      writing.mockRestore()
      host.release(SESSION, 'pane')
    }
  }
)

it('replays the same logical continuation through the durable send ledger', async () => {
  const { host, store, dispatch, marker } = await interruptedRestart()
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  const fence = store.getRecord(SESSION)?.lease.runtimeFence
  if (fence === undefined) {
    throw new Error('missing resumed lease')
  }
  const replay = await host.send(
    { callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER },
    restartContinuationEnvelope(SESSION, fence, marker)
  )
  expect(replay).toMatchObject({ ok: true, replayed: true })
  expect(host.journalSnapshot(SESSION).submissions).toHaveLength(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'keeps dispatched delivery unconfirmed when settlement fails (uncertainty write fails: %s)',
  async (uncertaintyFails) => {
    const { host, store, dispatch } = await interruptedRestart()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await host.restartResume.list()).toHaveLength(1)
    await host.hold(SESSION, 'pane')
    const settle = store.recordOperationOutcome.bind(store)
    let dispatched = false
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (input.outcome.status === 'succeeded') {
        dispatched = true
      }
      if (dispatched && (input.outcome.status === 'succeeded' || uncertaintyFails)) {
        throw new Error('operation outcome could not be persisted')
      }
      return settle(input)
    })

    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(host.journalSnapshot(SESSION).submissions[0]?.dispatchState).toBe('accepted')
    expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'unknown' }])
    // Filed as unconfirmed, with a warning in the chat; the continuation's own message is part of
    // the filed state, so it does not retire the record it caused.
    expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
    expect(statusNotes(host)).toContainEqual({
      text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
      tone: 'warning'
    })
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
    await host.restartResume.continueAfterRestart([SESSION], 'retry')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await host.restartResume.listFailures()).toMatchObject([{ outcome: 'unconfirmed' }])
    expect(warning.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ message: 'operation outcome could not be persisted' })
    )
    warning.mockRestore()
  }
)

it('releases a failed acquisition and leaves the offer retryable', async () => {
  const { host, acquire, dispatch, closeSession } = await interruptedRestart()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  expect(await host.restartResume.resume([SESSION], 'modal')).toMatchObject([
    { outcome: 'refused' }
  ])
  expect(host.isHeld(SESSION)).toBe(false)
  await host.restartResume.continueAfterRestart([SESSION], 'retry')
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(closeSession).not.toHaveBeenCalled()
})

it.each([false, true])(
  'admits one durable continuation under concurrent calls (pane already live: %s)',
  async (alreadyLive) => {
    const { host, root, acquire, dispatch } = await interruptedRestart()
    if (alreadyLive) {
      expect(await host.restartResume.list()).toHaveLength(1)
      await host.hold(SESSION, 'pane')
    }
    const results = await Promise.all([
      host.restartResume.continueAfterRestart([SESSION], 'window-one'),
      host.restartResume.continueAfterRestart([SESSION], 'window-two')
    ])
    expect(
      results.flatMap((result) => result.resumed).filter((r) => r.outcome === 'resumed')
    ).toHaveLength(1)
    expect(
      results.flatMap((result) => result.continued).filter((r) => r.outcome === 'continued')
    ).toHaveLength(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(1)
    expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
    await host.restartResume.continueAfterRestart([SESSION], 'later-click')
    expect(dispatch).toHaveBeenCalledTimes(1)
    host.release(SESSION, 'pane')
  }
)

it.each([false, true])(
  'releases reconnect acquisition to idle eviction (pane: %s)',
  async (pane) => {
    const { host, acquire, dispatch, closeSession } = await interruptedRestart()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await host.restartResume.resume([SESSION], 'modal')).toMatchObject([
      { outcome: 'resumed' }
    ])
    expect(host.isHeld(SESSION)).toBe(false)
    if (pane) {
      await host.hold(SESSION, 'pane')
      await vi.advanceTimersByTimeAsync(GRACE * 2)
      expect(closeSession).not.toHaveBeenCalled()
      host.release(SESSION, 'pane')
    }
    await vi.advanceTimersByTimeAsync(GRACE)
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1))
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  }
)

it('retains acquisition through slow continuation settlement, then releases it', async () => {
  const { host, dispatch, closeSession } = await interruptedRestart()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const settlement = Promise.withResolvers<Awaited<ReturnType<typeof dispatch>>>()
  const dispatched = Promise.withResolvers<void>()
  dispatch.mockImplementationOnce(() => {
    dispatched.resolve()
    return settlement.promise
  })
  const continuing = host.restartResume.continueAfterRestart([SESSION], 'modal')
  await dispatched.promise
  await vi.advanceTimersByTimeAsync(GRACE * 2)
  expect(host.isHeld(SESSION)).toBe(true)
  expect(closeSession).not.toHaveBeenCalled()
  settlement.resolve({ state: 'rejected', reason: 'provider refused' })
  expect((await continuing).continued).toMatchObject([{ outcome: 'refused' }])
  expect(host.isHeld(SESSION)).toBe(false)
  await vi.advanceTimersByTimeAsync(GRACE)
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1))
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// Opening the chat is inspection only. The explicit restart action is what removes the durable
// offer, so ordinary pane lifecycle must not make this status disappear.
it('keeps offering a chat after the user opens it', async () => {
  const { host, root, store } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await host.hold(SESSION, 'pane')
  host.release(SESSION, 'pane')
  await vi.advanceTimersByTimeAsync(GRACE)
  // The whole eviction, not just the provider stop: the lease returns to `released` on the step
  // before the last, and until it does the offer is refused for a reason that is not recovery.
  await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  vi.useRealTimers()

  expect(await host.restartResume.list()).toHaveLength(1)
  await host.restartResume.recordMarkers()
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
})

// The snooze, through the real quit path rather than a session map that cannot move: eviction
// forgets sessions BEFORE the write-back runs, so a marker whose journal is only reachable while
// the host still indexes it is exactly what a mock harness cannot catch.
it('carries a snoozed offer through a real teardown', async () => {
  const { host, root } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)
  await host.flushAllStreamedEvents({ trigger: 'quit' })
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
})

// Nothing acted on the capsule this launch, so it is still exactly as the last teardown left it.
it('keeps a durable offer intact through a teardown with no explicit action', async () => {
  const { host, root } = await interruptedRestart()
  await host.flushAllStreamedEvents({ trigger: 'quit' })
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
})

it('serializes teardown publication behind an explicit dismissal', async () => {
  await attach()
  const { host, root, acquire } = hostTestState()
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
    { kind: 'turn', turnId: 'working', state: 'running' }
  )
  await host.flushStreamedEvents(SESSION)
  host.restartResume.beginTeardown('quit')
  host.restartResume.captureBeforeStop(SESSION)
  host.restartResume.confirmStopped(SESSION)

  const releaseRecord = Promise.withResolvers<void>()
  const originalRecord = AgentSessionRecoveryCapsule.prototype.record
  const record = vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'record')
  record.mockImplementation(function (this: AgentSessionRecoveryCapsule, ...args) {
    return releaseRecord.promise.then(() => originalRecord.apply(this, args))
  })

  try {
    const recording = host.restartResume.recordMarkers()
    await Promise.resolve()
    const dismissed = host.restartResume.dismiss()
    releaseRecord.resolve()
    await Promise.all([recording, dismissed])
    expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  } finally {
    record.mockRestore()
  }
})

it('keeps concurrent recovery reads independent and non-destructive', async () => {
  const { host, root } = await interruptedRestart()
  const list = vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'list')
  const results = await Promise.all([host.restartResume.list(), host.restartResume.list()])
  expect(results.map((items) => items.length)).toEqual([1, 1])
  expect(list).toHaveBeenCalledTimes(2)
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
  list.mockRestore()
})

it('fails closed on corrupt recovery storage while ordinary hold and send still work', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  await writeFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), '{')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await host.restartResume.list()).toEqual([])
  expect(await host.restartResume.continueAfterRestart([SESSION], 'modal')).toEqual({
    resumed: [],
    continued: [],
    sessions: [],
    failed: []
  })
  await host.hold(SESSION, 'pane')
  const body = hostTestMessage('A fresh ordinary request')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  // list; the action's read of offers and of failures; the post-action refresh of both.
  expect(warning).toHaveBeenCalledTimes(5)
  warning.mockRestore()
  host.release(SESSION, 'pane')
})

// The toast is gone in seconds and the offer is spent by the reattach, so without this record
// nothing on any surface would still name the chat the user has to continue by hand.
it('keeps a refused continuation as a durable failure that names the chat and the reason', async () => {
  const { host, root, result } = await supersededRefusal()
  const failure = {
    sessionId: SESSION,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    latestPrompt: expect.any(String),
    agent: 'codex',
    retryable: false
  }
  expect(result).toMatchObject({ sessions: [], failed: [failure] })
  // The chat itself says what happened and what to do.
  expect(statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  expect(await host.restartResume.list()).toEqual([])
  expect(await host.restartResume.listFailures()).toMatchObject([failure])
  // Durable: a fresh reader of the same file sees it too.
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toMatchObject([
    { marker: { sessionId: SESSION }, outcome: 'refused' }
  ])
  host.release(SESSION, 'pane')
})

// The failure asked the user to continue the chat themselves; their own message is that
// continuation. Nothing on the send path clears it: the listing sees the newer message.
it('retires a recorded failure once the user sends in that chat, with no send hook', async () => {
  const { host, root } = await supersededRefusal()
  const body = hostTestMessage('Carry on from where you stopped')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  expect(await host.restartResume.listFailures()).toEqual([])
  // Pruned from the file too, not only hidden.
  await vi.waitFor(async () => {
    expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
  })
  host.release(SESSION, 'pane')
})

// The user can reply in a chat while other chats in the same action are still being continued,
// before its turn in the batch or after its own note asks them to. Either reply answers the failure.
it.each(['before', 'after'] as const)(
  'retires a failure the user answered %s its own attempt, before the action settled',
  async (userAnswers) => {
    const { host, root, result } = await supersededRefusal(userAnswers)
    expect(result.resumed).toMatchObject([
      userAnswers === 'before' ? { reason: 'agent_session_resume_not_eligible' } : {}
    ])
    expect(
      statusNotes(host).some(
        (note) => note.text === AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE
      )
    ).toBe(userAnswers === 'after')
    expect(result.failed).toEqual([])
    await vi.waitFor(async () => {
      expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
    })
    host.release(SESSION, 'pane')
  }
)

it('removes a failure when a named retry succeeds', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await host.restartResume.list()).toHaveLength(1)
  const [pending] = await capsule.list(NOW)
  await capsule.beginResume([SESSION], 'earlier-action', NOW)
  await capsule.failResume(
    'earlier-action',
    [
      {
        sessionId: SESSION,
        failedAt: NOW,
        outcome: 'refused',
        reason: 'agent_session_conflict',
        latestPrompt: '',
        latestUserItemId: pending!.latestUserItemId
      }
    ],
    NOW
  )
  expect(await host.restartResume.listFailures()).toMatchObject([{ retryable: true }])
  // An unselective action leaves it alone; naming it retries it.
  expect((await host.restartResume.continueAfterRestart(undefined, 'all')).resumed).toEqual([])
  const retried = await host.restartResume.continueAfterRestart([SESSION], 'retry')
  expect(retried.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(retried.failed).toEqual([])
  expect(await capsule.listFailed(NOW)).toEqual([])
})

it('dismisses one failure by name and leaves the rest of the durable records alone', async () => {
  const { host, root } = await supersededRefusal()
  const capsule = new AgentSessionRecoveryCapsule(root)
  const other = parseAgentSessionResumeMarker({
    sessionId: 'session-other',
    work: { kind: 'turn', id: 'turn-other' },
    latestUserItemId: null,
    recordedAt: NOW,
    trigger: 'quit',
    providerHandleRoot: 'codex:"thread-other"',
    teardownId: 'teardown-other'
  })
  if (!other) {
    throw new Error('fixture marker did not parse')
  }
  await capsule.record([other], NOW)

  expect(await host.restartResume.dismiss([SESSION])).toBe(1)
  expect(await host.restartResume.listFailures()).toEqual([])
  expect(await capsule.list(NOW)).toEqual([other])
  host.release(SESSION, 'pane')
})

it('logs teardown capsule publication failure and still releases the provider', async () => {
  const previous = hostTestState()
  await attach()
  const events = previous.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
    { kind: 'turn', turnId: 'working', state: 'running' }
  )
  await previous.host.flushStreamedEvents(SESSION)
  const capsulePath = join(previous.root, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  await mkdir(capsulePath)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(previous.host.flushAllStreamedEvents()).resolves.toBeUndefined()
  expect(() => previous.host.journalSnapshot(SESSION)).toThrow('agent_session_ownership_unknown')
  expect(warning).toHaveBeenCalledWith(
    '[structured-agent-session] recording recovery capsule failed'
  )
  expect(warning.mock.calls.flat().map(String).join(' ')).not.toContain(previous.root)
  expect(previous.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  warning.mockRestore()
  await rm(capsulePath, { recursive: true })
})
