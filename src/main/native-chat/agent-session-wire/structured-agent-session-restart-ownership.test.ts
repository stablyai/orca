import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { pendingApproval } from './structured-agent-session-restart-resume-test-harness'
import { restartContinuationEnvelope } from './structured-agent-session-restart-continuation'
import { AGENT_SESSION_RESTART_CONTINUATION_NOTE } from '../../../shared/agent-session-restart-continuation'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from './structured-agent-session-restart-resume-wiring'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

const GRACE = 15_000

async function interruptedRestart(
  work: 'turn' | 'submission' = 'turn',
  historyBoundaryConsistent = true
) {
  const previous = hostTestState()
  await attach()
  const events = previous.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  if (work === 'submission') {
    previous.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Perform the original task')
    await previous.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  } else {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'interrupted-turn', state: 'running' }
    )
  }
  await previous.host.flushStreamedEvents(SESSION)
  await previous.host.flushAllStreamedEvents()
  const store = await AgentSessionRecordStore.open({
    directory: join(previous.root, 'store'),
    hostId: 'local'
  })
  const closeSession = vi.fn(async () => true)
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      ...adapter(),
      closeSession,
      ...(work === 'submission'
        ? {
            providerHistoryWindow: async () => ({
              items: [],
              boundaryConsistent: historyBoundaryConsistent,
              turnInFlight: false
            })
          }
        : {})
    },
    journalRoot: previous.root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    recoveryCapsule: new AgentSessionRecoveryCapsule(previous.root),
    releaseGraceMs: GRACE,
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  previous.acquire.mockClear()
  previous.releaseAcquisition.mockClear()
  previous.dispatch.mockClear()
  const capsule = JSON.parse(
    await readFile(join(previous.root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  const marker = parseAgentSessionResumeMarker(capsule.entries[0]?.marker)
  return { ...hostTestState(), host, store, closeSession, marker }
}

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

it('does not continue work that acquisition proves was never delivered', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('submission')
  expect(await host.restartResume.list()).toHaveLength(1)
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(host.journalSnapshot(SESSION).submissions[0]).toMatchObject({
    dispatchState: 'rejected',
    reason: 'not_delivered'
  })
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).not.toHaveBeenCalled()
  expect(result.resumed).toMatchObject([{ outcome: 'refused' }])
  expect(host.isHeld(SESSION)).toBe(false)
})

it.each(['turn', 'message'] as const)(
  'checks interrupted work at send admission after a newer %s supersedes it',
  async (newer) => {
    const { host, store, acquire, dispatch } = await interruptedRestart()
    expect(await host.restartResume.list()).toHaveLength(1)
    await host.hold(SESSION, 'pane')
    const events = acquire.mock.calls[0]?.[0].events
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
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'newer-turn', ordinal: 1 },
      newer === 'turn'
        ? { kind: 'turn', turnId: 'newer-turn', state: 'completed' }
        : hostTestMessage('A newer task from another client')
    )
    await host.flushStreamedEvents(SESSION)
    proceed.resolve()
    expect((await continuing).resumed).toMatchObject([
      { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
    ])
    expect(dispatch).not.toHaveBeenCalled()
    expect(host.journalSnapshot(SESSION).submissions).toMatchObject([
      { dispatchState: 'rejected', reason: 'agent_session_restart_work_superseded' }
    ])
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
  }
)

it('refuses a completed turn even when its original delivery acknowledgement is unknown', async () => {
  const { host, store, acquire, dispatch } = await interruptedRestart('submission', false)
  expect(await host.restartResume.list()).toHaveLength(1)
  await host.hold(SESSION, 'pane')
  expect(host.journalSnapshot(SESSION).submissions[0]?.dispatchState).toBe('unknown')
  const events = acquire.mock.calls[0]?.[0].events
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
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'original-turn', ordinal: 1 },
    { kind: 'turn', turnId: 'original-turn', state: 'completed' }
  )
  await host.flushStreamedEvents(SESSION)
  proceed.resolve()
  expect((await continuing).resumed).toMatchObject([
    { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
  ])
  expect(dispatch).not.toHaveBeenCalled()
  expect(host.journalSnapshot(SESSION).submissions).toHaveLength(2)
  expect(host.journalSnapshot(SESSION).submissions[1]?.dispatchState).toBe('rejected')
  host.release(SESSION, 'pane')
  expect(host.isHeld(SESSION)).toBe(false)
})

it.each([
  { newer: 'completion', settlementFails: false },
  { newer: 'message', settlementFails: false },
  { newer: 'completion', settlementFails: true },
  { newer: 'message', settlementFails: true },
  { newer: 'approval', settlementFails: false },
  { newer: 'question', settlementFails: false },
  { newer: 'approval', settlementFails: true },
  { newer: 'question', settlementFails: true }
])(
  'refuses queued $newer before dispatch even if later settlement fails: $settlementFails',
  async ({ newer, settlementFails }) => {
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
        newer === 'completion'
          ? { kind: 'turn', turnId: 'original-turn', state: 'completed' }
          : newer === 'message'
            ? hostTestMessage('A newer task from another client')
            : {
                ...pendingApproval().body,
                question: 'Which action?',
                kind: newer === 'approval' ? 'approval' : 'question'
              },
        { lifecycle: true }
      )
    })

    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

    expect(result.continued).toMatchObject([
      { outcome: 'refused', reason: 'agent_session_restart_work_superseded' }
    ])
    expect(dispatch).not.toHaveBeenCalled()
    expect(host.journalSnapshot(SESSION).submissions).toHaveLength(2)
    expect(host.journalSnapshot(SESSION).submissions[1]?.dispatchState).toBe('rejected')
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
    expect(await host.restartResume.continueAfterRestart([SESSION], 'retry')).toEqual({
      resumed: [],
      continued: [],
      sessions: []
    })
    expect(dispatch).not.toHaveBeenCalled()
    if (settlementFails) {
      expect(store.recordOperationOutcome).toHaveBeenCalledOnce()
      expect(warning).not.toHaveBeenCalled()
    }
    warning.mockRestore()
  }
)

it.each(['completed', 'approval', 'question'] as const)(
  'refuses provider %s evidence accepted while recording the continuation',
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
      expect(result.continued).toMatchObject([{ outcome: 'refused' }])
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      writing.mockRestore()
      host.release(SESSION, 'pane')
    }
  }
)

it('refuses events accepted after the dispatch barrier was captured', async () => {
  const { host, acquire, dispatch } = await interruptedRestart()
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  const flush = host.flushStreamedEvents
  const draining = vi.spyOn(host, 'flushStreamedEvents').mockImplementationOnce(async (id) => {
    await flush(id)
    for (let ordinal = 2; ordinal < 6; ordinal += 1) {
      events.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal },
        ordinal === 5 ? pendingApproval().body : { kind: 'status', text: 'Provider tail' }
      )
    }
  })
  try {
    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
    expect(result.continued).toMatchObject([
      { outcome: 'refused', reason: 'agent_session_admission_evidence_unavailable' }
    ])
    expect(dispatch).not.toHaveBeenCalled()
    await flush(SESSION)
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    draining.mockRestore()
    host.release(SESSION, 'pane')
  }
})

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
    host.release(SESSION, 'pane')
    expect(host.isHeld(SESSION)).toBe(false)
    await host.restartResume.continueAfterRestart([SESSION], 'retry')
    expect(dispatch).toHaveBeenCalledTimes(1)
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
  host.restartResume.captureMarkers('quit')
  host.restartResume.confirmStoppedMarker(SESSION)

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
    sessions: []
  })
  await host.hold(SESSION, 'pane')
  const body = hostTestMessage('A fresh ordinary request')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalledTimes(3)
  warning.mockRestore()
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
