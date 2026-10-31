import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
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
  QUIT_CUT_NOTICE,
  startAgent,
  statusNotes,
  continuationCannotFold,
  supersededRefusal,
  throwAfterContinuationAccepted
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
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { inspect } from 'node:util'

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
  const { host, log } = await interruptedRestart()
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
      '[agent-session] restart-continuation-note: writing a restart continuation note failed',
      { scope: 'restart-continuation-note', sessionId: SESSION }
    )
    expect(log.scopes()).toContain('restart-continuation-note')
    expect(inspect(log.entries, { depth: 8 })).not.toContain('/private/account')
  } finally {
    write.mockRestore()
    warning.mockRestore()
  }
})

it.each(['turn', 'submission'] as const)(
  'does not continue a marked %s after the user submits new work without a provider echo',
  async (work) => {
    const { host, dispatch } = await interruptedRestart(work)
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

// Teardown judged the chat working. Whether the agent got the cut-off send is never guessed: it stays
// sent (STA-7416), and the continuation asks the agent to check what finished.
it('keeps a send a restart cut off as sent, and still continues its chat', async () => {
  const { host, acquire, dispatch } = await interruptedRestart('submission')
  expect(await host.restartResume.list()).toHaveLength(1)
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  const [cut] = (await host.journalSnapshot(SESSION)).submissions
  expect(cut).toMatchObject({ dispatchState: 'unknown', recovered: true })
  expect(cut).not.toHaveProperty('rejection')
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
})

it('offers and continues a send made after an earlier completed turn', async () => {
  const { host, dispatch, marker } = await interruptedRestart('send-after-reply')
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
  // Host-origin continuations cannot become personal kept cards.
  expect(sent).not.toHaveProperty('source')
  expect((await host.journalSnapshot(SESSION)).submissions[0]).not.toHaveProperty('source')
  const replay = await host.send(
    { callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER },
    { envelope: sent.envelope, body: sent.body }
  )
  expect(replay).toMatchObject({ ok: true, replayed: true })
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

// The row commits with its fold or not at all, and dispatch reads only committed sends.
it('refuses a continuation whose message cannot be recorded, without handing it to the agent', async () => {
  const { host, dispatch } = await interruptedRestart()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await host.restartResume.list()).toHaveLength(1)
  continuationCannotFold()

  const result = await host.restartResume
    .continueAfterRestart([SESSION], 'modal')
    .finally(() => vi.restoreAllMocks())

  expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'refused' }])
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'refused' }])
  expect((await host.journalSnapshot(SESSION)).submissions).toEqual([])
  expect(dispatch).not.toHaveBeenCalled()
})

it('reports a continuation delivered when its send throws after its message is in the chat', async () => {
  const { host, dispatch } = await interruptedRestart()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await host.restartResume.list()).toHaveLength(1)
  throwAfterContinuationAccepted()

  const result = await host.restartResume
    .continueAfterRestart([SESSION], 'modal')
    .finally(() => vi.restoreAllMocks())

  expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
  expect(result.failed).toEqual([])
  expect(dispatch).toHaveBeenCalledOnce()
  const notes = await statusNotes(host)
  expect(notes).toContainEqual({ text: AGENT_SESSION_RESTART_CONTINUATION_NOTE, tone: undefined })
  expect(notes.map((note) => note.text)).not.toContain(
    AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
  )
})

it('rejects the continuation when its start fails, and files a retryable refusal', async () => {
  const { host, acquire, dispatch, closeSession } = await interruptedRestart()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.resumed).toMatchObject([{ outcome: 'refused' }])
  expect(result.continued).toMatchObject([{ outcome: 'refused' }])
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
  settlement.resolve({
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
      surface: 'rejection'
    })
  })
  expect((await continuing).continued).toMatchObject([{ outcome: 'refused' }])
  expect(dispatch).toHaveBeenCalledTimes(1)
})

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

// Teardown evicts indexed sessions before write-back; a real host catches lost snoozed-marker access.
it('carries a snoozed offer through a real teardown', async () => {
  const { host, root } = await interruptedRestart()
  expect(await host.restartResume.list()).toHaveLength(1)
  await host.flushAllStreamedEvents({ trigger: 'quit' })
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
})

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
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
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
  const { host, root, dispatch, log } = await interruptedRestart()
  await writeFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), '{')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await host.restartResume.list()).toEqual([])
  expect(await host.restartResume.continueAfterRestart([SESSION], 'modal')).toEqual({
    resumed: [],
    continued: [],
    skipped: [SESSION],
    sessions: [],
    failed: []
  })
  const body = hostTestMessage('A fresh ordinary request')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  // Observe listing, action reads and final refresh; unreadable offers cannot withdraw on send.
  await vi.waitFor(() =>
    expect(log.entries.at(-1)).toEqual({
      level: 'warn',
      message: 'withdrawing a restart offer failed',
      fields: { scope: 'restart-offer-withdraw', sessionId: SESSION }
    })
  )
  // Count before console repeat suppression.
  expect(log.scopes().filter((scope) => scope !== 'restart-offer-withdraw')).toHaveLength(5)
  warning.mockRestore()
})

it("refuses a continuation quietly when the user's own message was accepted first", async () => {
  const { host, root, dispatch, result } = await supersededRefusal()
  expect(result).toMatchObject({
    continued: [{ outcome: 'refused', reason: 'agent_session_restart_work_superseded' }],
    sessions: [],
    failed: []
  })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(await statusNotes(host)).toEqual([QUIT_CUT_NOTICE])
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
})

async function failedContinuation() {
  const state = await interruptedRestart()
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const result = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'refused' }])
  return state
}

it('retires a recorded failure once the user sends in that chat, with no send hook', async () => {
  const { host, root, dispatch } = await failedContinuation()
  const body = hostTestMessage('Carry on from where you stopped')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
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
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
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
    '[agent-session] teardown-recovery-capsule: recording the recovery capsule at teardown failed',
    { scope: 'teardown-recovery-capsule' }
  )
  expect(inspect(warning.mock.calls, { depth: 8 })).not.toContain(previous.root)
  expect(previous.log.scopes()).toContain('teardown-recovery-capsule')
  expect(inspect(previous.log.entries, { depth: 8 })).not.toContain(previous.root)
  expect(previous.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  warning.mockRestore()
  await rm(capsulePath, { recursive: true })
})

// Renderer guidance keys on refusal code; retain details beside it.
it('files a restart refused by a conflicted claim under its code, with its details beside it', async () => {
  // The terminal agent that holds the claim is still running, so nothing may take it over.
  const { host, store } = await interruptedRestart('turn', async () => ({
    outcome: 'identity-matched',
    matchedOn: ['spawn-token']
  }))
  await store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'conflicted',
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'terminal' }
    }
  }))

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  await vi.waitFor(async () =>
    expect(await host.restartResume.listFailures()).toMatchObject([
      { reason: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
    ])
  )
})
