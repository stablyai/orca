// A restart offer ends when the chat moves on after the restart: another message accepted, or its
// agent started, other than by the offer's own continuation. Each case reads the offer list and the
// capsule, never only an in-memory set.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  interruptedRestart,
  statusNotes
} from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import { createStructuredAgentSessionRestartOfferWithdrawal } from './structured-agent-session-restart-offer-withdrawal'
import { sweepOnce } from './structured-agent-session-rest-test-rig'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

const SUPERSEDED = 'agent_session_restart_work_superseded'

/** A start under a loaded machine: reconcile, acquire, hand over. */
const COLD_START = { timeout: 10_000 }

async function offered(work: 'turn' | 'submission' = 'turn') {
  const state = await interruptedRestart(work, false)
  expect(await state.host.restartResume.list()).toHaveLength(1)
  return state
}

function offersIn(root: string) {
  return new AgentSessionRecoveryCapsule(root).list(NOW)
}

function userSend(text: string) {
  const body = hostTestMessage(text)
  return { envelope: envelope('agentSession.send', { body }), body }
}

function compactParams() {
  return {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
}

function sentTexts(dispatch: Awaited<ReturnType<typeof offered>>['dispatch']): string[] {
  return dispatch.mock.calls.map(([input]) =>
    input.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  )
}

it('withdraws the offer when /compact starts the agent at rest (R-01)', async () => {
  const { host, root, acquire } = await offered()
  Object.assign(host.deps.adapter, { compact: vi.fn(async () => ({})) })

  expect(await host.conversationCommand(CALLER, compactParams())).toMatchObject({ ok: true })

  expect(acquire).toHaveBeenCalledOnce()
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]), COLD_START)
  expect(await host.restartResume.list()).toEqual([])
})

it('keeps the offer through every way of looking at the chat (R-02)', async () => {
  const { host, root, acquire } = await offered()
  const unsubscribe = await host.subscribe({ id: 'pane', sessionId: SESSION, emit: vi.fn() })
  await host.history({ sessionId: SESSION, direction: 'tail' })
  await host.readOptions(SESSION)
  host.readCommands(SESSION)
  await host.handoffStatus(SESSION)
  await host.revealSession(SESSION)
  unsubscribe()

  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.list()).toHaveLength(1)
  expect(await offersIn(root)).toHaveLength(1)
})

it("does not let the offer's own continuation withdraw it (R-03)", async () => {
  const { host, root, dispatch } = await offered()
  const dismiss = vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'dismiss')

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledOnce()
  expect(dismiss).not.toHaveBeenCalled()
  // Ended by the success path instead.
  expect(await offersIn(root)).toEqual([])
})

it('refuses the continuation when another start lands inside its action (R-03b)', async () => {
  const { host, root, dispatch } = await offered()
  Object.assign(host.deps.adapter, { compact: vi.fn(async () => ({})) })
  const send = host.send
  vi.spyOn(host, 'send').mockImplementationOnce(async (caller, params) => {
    // Another client's /compact starts the agent after the action reserved the offer.
    expect(await host.conversationCommand(CALLER, compactParams())).toMatchObject({ ok: true })
    return send(caller, params)
  })

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toMatchObject([{ outcome: 'refused', reason: SUPERSEDED }])
  expect(dispatch).not.toHaveBeenCalled()
  expect(await offersIn(root)).toEqual([])
  expect(result.failed).toEqual([])
})

it('keeps the offer when a tabbed chat is restored at boot (R-05)', async () => {
  const { host, store, root, acquire } = await offered()
  await store.setSessionTabVisibility(SESSION, true)

  await host.restoreStartupSessions()

  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.list()).toHaveLength(1)
  expect(await offersIn(root)).toHaveLength(1)
})

it('reads an older build’s marker whose message id no longer matches, and one with none (R-06)', async () => {
  const { host, root, dispatch, marker } = await offered('submission')
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  // The older build compared this id with the chat's newest message; nothing does now.
  await host.restartResume.dismiss([SESSION])
  await new AgentSessionRecoveryCapsule(root).record(
    [{ ...marker, latestUserItemId: 'user-sent-under-the-older-build' }],
    NOW
  )
  expect(await host.restartResume.list()).toHaveLength(1)
  const { latestUserItemId: _dropped, ...withoutId } = marker
  expect(parseAgentSessionResumeMarker(withoutId)).toEqual(withoutId)

  await host.send(CALLER, userSend('Carry on'))
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), COLD_START)
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]), COLD_START)
})

it('still writes the message id the previous build requires on every marker', async () => {
  const { root } = await offered('submission')
  const capsule = JSON.parse(
    await readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  expect(capsule.entries[0]?.marker).toHaveProperty('latestUserItemId')
})

/** Sends a message whose start fails, and waits for it to be rejected. */
async function sendWhoseStartFails(state: Awaited<ReturnType<typeof offered>>) {
  state.acquire.mockRejectedValueOnce(new Error('Not signed in'))
  const params = userSend('while signed out')
  await state.host.send(CALLER, params)
  await vi.waitFor(async () =>
    expect(
      (await state.host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === params.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  )
}

// A message the user sent is activity even when its start then failed.
it('withdraws the offer when the user sends a message whose start then fails (R-08)', async () => {
  const state = await offered()
  const { host, root, dispatch } = state

  await sendWhoseStartFails(state)

  expect(await host.restartResume.list()).toEqual([])
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]), COLD_START)
  // A click from a surface that still shows the offer finds nothing to act on.
  expect(await host.restartResume.continueAfterRestart([SESSION], 'stale-click')).toMatchObject({
    resumed: [],
    continued: []
  })
  expect(dispatch).not.toHaveBeenCalled()
})

// The idle sweep closes a chat's open handle, and the next read opens a new one: the user's message
// still counts, because it is read against where the journal stood when the offer was taken.
it('keeps the offer withdrawn after the idle sweep closes the chat and it is read again', async () => {
  const state = await offered()
  const { host, root, clock } = state
  await sendWhoseStartFails(state)
  clock.now += STRUCTURED_AGENT_SESSION_IDLE_MS + 1

  await sweepOnce(host)
  expect(host.hasSession(SESSION)).toBe(false)
  await host.revealSession(SESSION)

  expect(await host.restartResume.list()).toEqual([])
  // The listing retires what it finds moved on; the write trails the answer.
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]))
})

// A failure the chat moved on from is read from its journal like an offer is, open or not.
it('keeps a failure not retryable after the user moved on and the sweep closed the chat', async () => {
  const state = await offered()
  const { host, clock } = state
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const resumed = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(resumed.failed).toMatchObject([{ sessionId: SESSION, retryable: true }])
  await sendWhoseStartFails(state)
  expect(await host.restartResume.listFailures()).toMatchObject([{ retryable: false }])
  clock.now += STRUCTURED_AGENT_SESSION_IDLE_MS + 1

  await sweepOnce(host)
  expect(host.hasSession(SESSION)).toBe(false)

  expect(await host.restartResume.listFailures()).toMatchObject([{ retryable: false }])
})

const DAY_AND_AN_HOUR = 25 * 60 * 60 * 1000

// An offer has no expiry; the ledger refuses a new id dated more than a day back.
it('resumes more than a day after the quit', async () => {
  const state = await offered()
  const { host, clock, dispatch } = state
  clock.now += DAY_AND_AN_HOUR

  const resumed = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(resumed.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
  expect(sentTexts(dispatch)).toHaveLength(1)
  expect(await host.restartResume.listFailures()).toEqual([])
})

// The offer remembers its own continuations; nothing about them expires before the offer does.
it('keeps a failed resume retryable more than a day later, after the ledger pruned its row', async () => {
  const state = await offered()
  const { host, clock, store } = state
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const first = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(first.failed).toMatchObject([{ sessionId: SESSION, retryable: true }])
  clock.now += DAY_AND_AN_HOUR
  // What an app restart does to the operation ledger a day on.
  await store.reconcileOnRestart({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reconciliation only reads the probe outcome.
    probe: async () => ({ outcome: 'pid-absent' }) as never,
    now: clock.now
  })

  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, retryable: true }
  ])
  const retried = await host.restartResume.continueAfterRestart([SESSION], 'retry')
  expect(retried.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
})

// The rejected continuation is the chat's newest user message; the row still names the user's.
it("names the user's prompt on a failed retry, not the rejected continuation", async () => {
  const state = await offered('submission')
  const { host } = state
  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const first = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(first.failed).toMatchObject([{ latestPrompt: 'Perform the original task' }])

  state.acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const retried = await host.restartResume.continueAfterRestart([SESSION], 'retry')

  expect(retried.failed).toMatchObject([
    { latestPrompt: 'Perform the original task', retryable: true }
  ])
})

// Resume that runs by itself at launch goes through the same call a click does, and the same rule
// decides: whichever of the two was accepted first since the restart wins.
it("refuses an automatic continuation when the user's message was accepted first, and writes nothing", async () => {
  const { host, root, dispatch } = await offered()
  const events: AgentSessionSubscribeEvent[] = []
  const unsubscribe = await host.subscribe({
    id: 'pane',
    sessionId: SESSION,
    emit: (event) => events.push(structuredClone(event))
  })
  const send = host.send
  vi.spyOn(host, 'send').mockImplementationOnce(async (caller, params) => {
    // Both accepted before any start, the user's first: the continuation queues behind the user's
    // acceptance, ahead of the start that acceptance wakes.
    let continuation: ReturnType<typeof send> | undefined
    const append = AgentSessionJournal.prototype.appendSubmission
    vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockImplementationOnce(
      async function (this: AgentSessionJournal, ...args) {
        continuation = send(caller, params)
        await new Promise((resolve) => setTimeout(resolve, 50))
        return append.apply(this, args)
      }
    )
    await send(CALLER, userSend('A new request'))
    return continuation!
  })

  const result = await host.restartResume.continueAfterRestart(undefined, 'launch')

  expect(result.continued).toMatchObject([{ outcome: 'refused', reason: SUPERSEDED }])
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), COLD_START)
  expect(sentTexts(dispatch)).toEqual(['A new request'])
  // Nothing the user did failed: no row reached the reader, and nothing is kept.
  expect(await statusNotes(host)).toEqual([])
  expect(
    events.some(
      (event) =>
        event.type === 'batch' && event.batch.items.some((item) => item.body.kind === 'status')
    )
  ).toBe(false)
  expect(await offersIn(root)).toEqual([])
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
  unsubscribe()
})

it('delivers a clicked continuation and a message sent right after it, in the order accepted', async () => {
  const { host, root, dispatch } = await offered()
  const send = host.send
  vi.spyOn(host, 'send').mockImplementationOnce(async (caller, params) => {
    const continuation = send(caller, params)
    const user = send(CALLER, userSend('And then this'))
    await user
    return continuation
  })

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2), COLD_START)
  const [first, second] = sentTexts(dispatch)
  expect(first).not.toBe('And then this')
  expect(second).toBe('And then this')
  expect(await offersIn(root)).toEqual([])
})

describe('reading the chat against where the offer was taken', () => {
  const TAKEN = { epoch: 'epoch-1', sequence: 5 }

  function movedOn(
    input: {
      epoch?: string
      submissions?: { clientMessageId: string; acceptedSequence: number; dispatchState: string }[]
      continuations?: string[]
    },
    journalCursor: { epoch: string; sequence: number } | null = TAKEN
  ): boolean {
    const session = {
      child: null,
      journal: {
        cursor: () => ({ epoch: input.epoch ?? TAKEN.epoch, sequence: 9 }),
        submissions: () => input.submissions ?? []
      }
    }
    const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fact reads only the journal's cursor and submissions and the child fields given here.
      sessions: new Map([[SESSION, session as never]]),
      now: () => NOW,
      enqueue: (operation) => operation()
    })
    return withdrawal.movedOn({
      sessionId: SESSION,
      work: { kind: 'turn', id: 'turn-1' },
      recordedAt: NOW,
      trigger: 'quit',
      providerHandleRoot: 'codex:"thread"',
      teardownId: 'teardown-1',
      ...(journalCursor ? { journalCursor } : {}),
      ...(input.continuations ? { continuations: input.continuations } : {})
    })
  }

  it('counts a message accepted after that position, and nothing before it', () => {
    const at = (acceptedSequence: number) => ({
      clientMessageId: `m-${acceptedSequence}`,
      acceptedSequence,
      dispatchState: 'rejected'
    })
    expect(movedOn({ submissions: [at(4), at(5)] })).toBe(false)
    expect(movedOn({ submissions: [at(4), at(6)] })).toBe(true)
  })

  it('counts a journal on another epoch as moved on', () => {
    expect(movedOn({ epoch: 'epoch-2' })).toBe(true)
  })

  it('does not count a rejected continuation, so a retry still runs', () => {
    const rejected = { clientMessageId: 'c-1', acceptedSequence: 7, dispatchState: 'rejected' }
    expect(movedOn({ submissions: [rejected], continuations: ['c-1'] })).toBe(false)
    expect(
      movedOn({ submissions: [{ ...rejected, dispatchState: 'accepted' }], continuations: ['c-1'] })
    ).toBe(true)
  })

  it('leaves an older build’s offer, which recorded no position, to a start', () => {
    const after = { clientMessageId: 'm-7', acceptedSequence: 7, dispatchState: 'accepted' }
    expect(movedOn({ submissions: [after], epoch: 'epoch-2' }, null)).toBe(false)
  })
})
