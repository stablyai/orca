// A restart offer ends when the chat's agent is started again, other than by its own continuation,
// and a message and a continuation racing to be first are decided at acceptance. Each case reads
// the offer list and the capsule, never only an in-memory set.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
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
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

const SUPERSEDED = 'agent_session_restart_work_superseded'

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
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]))
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

  await host.restoreReadableSessions([SESSION])

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
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect(await offersIn(root)).toEqual([]))
})

it('still writes the message id the previous build requires on every marker', async () => {
  const { root } = await offered('submission')
  const capsule = JSON.parse(
    await readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  expect(capsule.entries[0]?.marker).toHaveProperty('latestUserItemId')
})

it('keeps the offer when the send that would start the agent fails to (R-08)', async () => {
  const { host, root, acquire } = await offered()
  acquire.mockRejectedValueOnce(new Error('Not signed in'))
  const params = userSend('while signed out')

  await host.send(CALLER, params)

  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === params.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  )
  expect(await host.restartResume.list()).toHaveLength(1)
  expect(await offersIn(root)).toHaveLength(1)
})

it('keeps the offer a quit captures when a start lands while quitting (R-09)', async () => {
  const { host, root, acquire } = await offered()
  const starting = Promise.withResolvers<void>()
  const acquired = Promise.withResolvers<void>()
  const spawn = acquire.getMockImplementation()!
  acquire.mockImplementationOnce(async (input) => {
    acquired.resolve()
    await starting.promise
    return spawn(input)
  })
  await host.send(CALLER, userSend('started as the app quits'))
  await acquired.promise

  const quitting = host.flushAllStreamedEvents({ trigger: 'quit' })
  starting.resolve()
  await quitting

  expect(await offersIn(root)).toHaveLength(1)
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
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
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
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  const [first, second] = sentTexts(dispatch)
  expect(first).not.toBe('And then this')
  expect(second).toBe('And then this')
  expect(await offersIn(root)).toEqual([])
})

// The user's message came first but its start failed, so no start withdrew the offer: Resume is
// still refused quietly, and nothing is filed for the user to act on.
it("files nothing when Resume loses to the user's message whose start failed", async () => {
  const { host, root, acquire, dispatch } = await offered()
  acquire.mockRejectedValueOnce(new Error('Not signed in'))
  const params = userSend('while signed out')
  await host.send(CALLER, params)
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions.find(
        (entry) => entry.clientMessageId === params.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  )
  expect(await host.restartResume.list()).toHaveLength(1)

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result).toMatchObject({
    continued: [{ outcome: 'refused', reason: SUPERSEDED }],
    sessions: [],
    failed: []
  })
  expect(dispatch).not.toHaveBeenCalled()
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
  expect(await offersIn(root)).toEqual([])
})
