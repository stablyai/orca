import { mkdir, rm, writeFile } from 'node:fs/promises'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from './structured-agent-session-restart-resume-wiring'
import {
  interruptedRestart,
  startAgent,
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
  const unsubscribe = await host.subscribe({ id: 'pane', sessionId: SESSION, emit })
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
    await startAgent(hostTestState())
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Stop the old task and do this instead')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(work === 'turn' ? 1 : 2)
  }
)

// Teardown judged the chat working. A send the provider proves it never received is still the chat
// Orca stopped; the continuation asks the agent
// to check what finished rather than refusing.
it('still continues a chat whose last send acquisition proves was never delivered', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('submission')
  expect(await host.restartResume.list()).toHaveLength(1)
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect((await host.journalSnapshot(SESSION)).submissions[0]).toMatchObject({
    dispatchState: 'rejected',
    reason: 'not_delivered'
  })
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
})

// The send the user made just before quitting, after an earlier exchange had finished: that
// finished turn does not withdraw it.
it('offers and continues a send made after an earlier completed turn', async () => {
  const { host, dispatch, marker } = await interruptedRestart('send-after-reply', false)
  expect(marker?.work.kind).toBe('submission')
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('replays the same logical continuation through the durable send ledger', async () => {
  const { host, dispatch } = await interruptedRestart()
  const sending = vi.spyOn(host, 'send')
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  const sent = sending.mock.calls[0]?.[1]
  sending.mockRestore()
  if (!sent) {
    throw new Error('the continuation was not sent')
  }
  const replay = await host.send(
    { callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER },
    { envelope: sent.envelope, body: sent.body }
  )
  expect(replay).toMatchObject({ ok: true, replayed: true })
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// A send that throws after Orca may have taken it is not proof it was not delivered.
it.each([false, true])(
  'keeps a continuation unconfirmed when its acceptance cannot be recorded (uncertainty write fails: %s)',
  async (uncertaintyFails) => {
    const { host, store } = await interruptedRestart()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await host.restartResume.list()).toHaveLength(1)
    const settle = store.recordOperationOutcome.bind(store)
    const recording = vi.spyOn(store, 'recordOperationOutcome')
    recording.mockImplementation(async (input) => {
      // Only the continuation's own record: the start it makes records its attach as usual.
      if (
        input.callerKey === STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER &&
        (input.outcome.status === 'succeeded' || uncertaintyFails)
      ) {
        throw new Error('operation outcome could not be persisted')
      }
      return settle(input)
    })

    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

    expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'unknown' }])
    // Filed as unconfirmed, with a warning in the chat.
    expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
    expect(await statusNotes(host)).toContainEqual({
      text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
      tone: 'warning'
    })
    recording.mockRestore()
    warning.mockRestore()
  }
)

// The continuation is accepted, then its start fails: the message is rejected with the cause and
// the failure is filed, and nothing is stopped because nothing started.
it('rejects the continuation when its start fails, and files a retryable refusal', async () => {
  const { host, acquire, dispatch, closeSession } = await interruptedRestart()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.resumed).toMatchObject([{ outcome: 'refused' }])
  expect(result.continued).toMatchObject([{ outcome: 'refused' }])
  // Nothing ran, so the offer stands as a failure a retry can act on.
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'refused', retryable: true }])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  expect((await host.journalSnapshot(SESSION)).submissions).toMatchObject([
    { dispatchState: 'rejected' }
  ])
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).not.toHaveBeenCalled()
  expect(closeSession).not.toHaveBeenCalled()
})

it('admits one durable continuation under concurrent calls', async () => {
  const { host, root, acquire, dispatch } = await interruptedRestart()
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
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  await host.restartResume.continueAfterRestart([SESSION], 'later-click')
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// The batch counts a chat done once its agent took the continuation; the provider's slow answer is
// awaited after, and decides the outcome.
it('waits out a slow provider answer before reporting the continuation', async () => {
  const { host, dispatch } = await interruptedRestart()
  const settlement = Promise.withResolvers<Awaited<ReturnType<typeof dispatch>>>()
  const dispatched = Promise.withResolvers<void>()
  dispatch.mockImplementationOnce(() => {
    dispatched.resolve()
    return settlement.promise
  })
  let settled = false
  const continuing = host.restartResume
    .continueAfterRestart([SESSION], 'modal')
    .finally(() => (settled = true))
  await dispatched.promise
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(settled).toBe(false)
  settlement.resolve({ state: 'rejected', reason: 'provider refused' })
  expect((await continuing).continued).toMatchObject([{ outcome: 'refused' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// Opening the chat is inspection only: it starts nothing, and the explicit restart action is what
// removes the durable offer, so reading the chat must not make this status disappear.
it('keeps offering a chat after the user opens it', async () => {
  const { host, root, acquire } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)
  const unsubscribe = await host.subscribe({ id: 'pane', sessionId: SESSION, emit: vi.fn() })
  await host.history({ sessionId: SESSION, direction: 'tail' })
  unsubscribe()
  expect(acquire).not.toHaveBeenCalled()

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

it('fails closed on corrupt recovery storage while an ordinary send still works', async () => {
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
  const body = hostTestMessage('A fresh ordinary request')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  // list; the action's read of offers and of failures; the post-action refresh of both; and the
  // send's start, which cannot withdraw an offer it cannot read.
  expect(warning).toHaveBeenCalledTimes(6)
  expect(warning).toHaveBeenLastCalledWith(
    '[structured-agent-session] withdrawing a restart offer failed'
  )
  warning.mockRestore()
})

// The user's own message was accepted first: the continuation is refused, and since nothing the
// user did failed, the chat says nothing and no failure is kept.
it("refuses a continuation quietly when the user's own message was accepted first", async () => {
  const { host, root, dispatch, result } = await supersededRefusal()
  expect(result).toMatchObject({
    continued: [{ outcome: 'refused', reason: 'agent_session_restart_work_superseded' }],
    sessions: [],
    failed: []
  })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(await statusNotes(host)).toEqual([])
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
})

/** A continuation whose start failed, filed as a retryable failure. */
async function failedContinuation() {
  const state = await interruptedRestart()
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const result = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'refused' }])
  return state
}

// Starting the chat's agent again answers a failure, as it ends an offer.
it('retires a recorded failure once the user sends in that chat, with no send hook', async () => {
  const { host, root, dispatch } = await failedContinuation()
  const body = hostTestMessage('Carry on from where you stopped')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  // Pruned from the file, not only hidden.
  await vi.waitFor(async () => {
    expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
  })
  expect(await host.restartResume.listFailures()).toEqual([])
})

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
        latestUserItemId: pending!.latestUserItemId ?? null
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
  const { host, root } = await failedContinuation()
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
  await expect(previous.host.journalSnapshot(SESSION)).rejects.toThrow(
    'agent_session_ownership_unknown'
  )
  expect(warning).toHaveBeenCalledWith(
    '[structured-agent-session] recording recovery capsule failed'
  )
  expect(warning.mock.calls.flat().map(String).join(' ')).not.toContain(previous.root)
  expect(previous.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  warning.mockRestore()
  await rm(capsulePath, { recursive: true })
})
