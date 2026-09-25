// A send, or a hold, that finds the session's provider child gone, against the real host. The
// send is accepted at once; its delivery restarts the child, or rejects it with the reason.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let spawnChild: StructuredAgentSessionAdapter['acquire']
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let hostErrors: unknown[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-recovery-'))
  resetHostTestOperationIds()
  hostErrors = []
  let generation = 0
  spawnChild = async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${++generation}`,
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  })
  acquire = vi.fn(spawnChild)
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW,
    onEventSinkError: ({ error }) => hostErrors.push(error)
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string, operationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  const envelope: AgentSessionMutationEnvelope = {
    sessionId: SESSION,
    clientOperationId: operationId,
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  return { envelope, body }
}

/** Accepted at once, before any owner exists for it; answers the message id. */
async function accept(params: ReturnType<typeof sendParams>): Promise<string> {
  const result = await host.send(CALLER, params)
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    replayed: false,
    value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
  })
  return params.envelope.clientOperationId
}

async function submission(clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

/** The submission once delivery is done with it: handed over, or rejected unwritten. */
async function settled(clientMessageId: string) {
  await eventually(async () => {
    const current = await submission(clientMessageId)
    expect(current?.dispatchState !== 'pending' || current.handedOverAt !== undefined).toBe(true)
  })
  return submission(clientMessageId)
}

/** The failure rows a start the chat needed left, oldest first. */
async function errorStatuses(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
}

/** The child timed out or exited: its lease is handed back and the host holds no session. */
async function loseOwner(): Promise<void> {
  await host.close(SESSION)
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'released',
    ownerProcess: null
  })
  acquire.mockClear()
}

describe('a send with no live owner', () => {
  it('restarts the owner once and delivers against it', async () => {
    await loseOwner()

    await accept(sendParams('after the child died'))

    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('accepts the send before anything restarts, and the restart hands it over', async () => {
    await loseOwner()
    const order: string[] = []
    const spawnChild = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      order.push('acquire')
      return spawnChild(input)
    })
    const admit = store.admitMutationOperation
    vi.spyOn(store, 'admitMutationOperation').mockImplementation((args) => {
      order.push('admit')
      return admit(args)
    })

    await accept(sendParams('accept first'))
    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())

    expect(order).toEqual(['admit', 'acquire'])
  })

  it('leaves a live owner alone', async () => {
    acquire.mockClear()

    await accept(sendParams('owner is live'))

    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).not.toHaveBeenCalled()
  })

  it('does not restart an owner for a send the session refuses anyway', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: 'session-after-clear',
        operationId: hostTestOperationId(),
        callerKey: CALLER.callerKey,
        phase: 'committed'
      }
    }))

    await expect(host.send(CALLER, sendParams('into a cleared chat'))).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })

    expect(acquire).not.toHaveBeenCalled()
  })

  it('restarts an owner that exited while the session stayed readable', async () => {
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    expect(host.hasSession(SESSION)).toBe(true)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    acquire.mockClear()

    await accept(sendParams('after an exit'))
    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('restarts nothing for a resend the journal already answers', async () => {
    const params = sendParams('sent once')
    await accept(params)
    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    // The child died during startup: the lease is handed back, the fence moves, and the session
    // stays readable. The client resends against the new fence.
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'startup deadline',
      cause: 'unexpected-exit',
      fence: params.envelope.expectedRuntimeFence ?? 0,
      acquisitionGeneration: 'generation-1',
      startupUnproven: true
    })
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    acquire.mockClear()
    const resent = {
      ...params,
      envelope: {
        ...params.envelope,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0
      }
    }

    await expect(host.send(CALLER, resent)).resolves.toMatchObject({ ok: true, replayed: true })

    expect(acquire).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')

    // Retry rotates the id: a genuinely new send restarts the owner once.
    await accept(sendParams('sent once'))
    await eventually(async () => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('restarts nothing for a send the ledger holds but the journal never saw', async () => {
    const params = sendParams('claimed, then the host died')
    // The row was claimed and the host went down before the journal write: on replay, admission
    // reconstructs an unknown-outcome submission and never needs an owner.
    await store.admitMutationOperation({
      callerKey: CALLER.callerKey,
      envelope: params.envelope,
      hostFingerprint: params.envelope.payloadFingerprint,
      now: NOW,
      operationIdScope: 'global'
    })
    await store.recordOperationOutcome({
      callerKey: CALLER.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'unknown' }
    })
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: params.envelope.expectedRuntimeFence ?? 0,
      acquisitionGeneration: 'generation-1'
    })
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    acquire.mockClear()

    const result = await host.send(CALLER, {
      ...params,
      envelope: {
        ...params.envelope,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0
      }
    })

    expect(result).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'unknown', recovered: true } }
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('accepts a send that arrives while a restart holds the queue, and hands both over in order', async () => {
    await loseOwner()
    const lostFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    let claimed = () => {}
    let release = () => {}
    const claim = new Promise<void>((resolve) => (claimed = resolve))
    const spawn = new Promise<void>((resolve) => (release = resolve))
    const spawnChild = acquire.getMockImplementation()
    acquire.mockImplementationOnce(async (input) => {
      claimed()
      await spawn
      return spawnChild!(input)
    })

    const first = await accept(sendParams('first'))
    await claim
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(lostFence + 1)
    // Written against the lost owner's fence, which admits it: a send is a conversation write.
    const late = sendParams('second')
    late.envelope.expectedRuntimeFence = lostFence
    const second = host.send(CALLER, late)
    release()

    expect(await second).toMatchObject({ ok: true })
    await eventually(async () => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([
      first,
      late.envelope.clientOperationId
    ])
  })

  it('shares one restart between concurrent sends', async () => {
    await loseOwner()

    const results = await Promise.all([
      host.send(CALLER, sendParams('first')),
      host.send(CALLER, sendParams('second')),
      host.send(CALLER, sendParams('third'))
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, true])
    await eventually(async () => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('replays into a closed session without spawning anything', async () => {
    const params = sendParams('sent once')
    await accept(params)
    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    await loseOwner()

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })

    // The conversation was opened for the answer; the record's lease was left as it was.
    expect(host.hasSession(SESSION)).toBe(true)
    expect(acquire).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it("rejects the accepted message with the restart's own cause, and says so in the chat once", async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in. Run codex login'))
    const params = sendParams('while signed out')
    const cause =
      'The provider stopped before it finished starting: Not signed in. Run codex login.'

    const id = await accept(params)

    expect(await settled(id)).toMatchObject({ dispatchState: 'rejected', reason: cause })
    expect(dispatch).not.toHaveBeenCalled()
    // Accepted, so the ledger answers a resend with the rejection rather than a second attempt.
    expect(
      store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)
    ).toMatchObject({ outcome: { status: 'succeeded' } })
    // One row, in the error tone, so the reason outlives the error strip.
    expect(await errorStatuses()).toEqual([cause])
  })

  it('restarts again for a Retry under a new id, and replays a resend of the same id', async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in'))
    const params = sendParams('while signed out')
    await settled(await accept(params))
    expect(acquire).toHaveBeenCalledTimes(1)

    // A client that resends the same id gets the recorded rejection, and the chat no second row.
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'rejected' } }
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(await errorStatuses()).toHaveLength(1)

    // The outbox's Retry rotates the id: a fresh attempt, with its own row.
    expect(await settled(await accept(sendParams('while signed out')))).toMatchObject({
      dispatchState: 'rejected'
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(await errorStatuses()).toHaveLength(2)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('restarts and delivers a later send once the cause clears', async () => {
    await loseOwner()
    acquire.mockRejectedValueOnce(new Error('Not signed in'))
    expect(await settled(await accept(sendParams('while signed out')))).toMatchObject({
      dispatchState: 'rejected'
    })

    // The user signed in; nothing about the failed attempt is remembered.
    await accept(sendParams('signed in now'))
    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('suggests a new chat only when this host has nothing to restart the chat from', async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in'))
    const failed = await settled(await accept(sendParams('restart fails')))
    expect(failed).toMatchObject({ dispatchState: 'rejected' })
    expect(failed?.reason).not.toMatch(/new chat/)

    // The adapter cannot run this record where it lives: no retry would bring it back.
    host.deps.adapter.supportsLocation = () => false
    const unresumable = await settled(await accept(sendParams('cannot resume here')))

    expect(unresumable).toMatchObject({
      dispatchState: 'rejected',
      reason:
        "Codex couldn't restart: This execution host cannot resume the requested structured agent session. Start a new chat to continue."
    })
  })

  it('rejects the message with the cause when the restart met a lease someone else is settling', async () => {
    await loseOwner()
    vi.spyOn(
      host['conversationDelivery'].loop['deps'],
      'ensureProviderChild'
    ).mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'execution_owner_reconciling',
        message: 'Another runtime is still adjudicating this lease.'
      }
    })

    const id = await accept(sendParams('owner being settled'))

    const cause = "Codex couldn't restart: Another runtime is still adjudicating this lease."
    expect(await settled(id)).toMatchObject({ dispatchState: 'rejected', reason: cause })
    expect(acquire).not.toHaveBeenCalled()
    expect(await errorStatuses()).toEqual([cause])
  })

  it('rejects the message, and reports the fault, when the restart itself faults', async () => {
    await loseOwner()
    vi.spyOn(
      host['conversationDelivery'].loop['deps'],
      'ensureProviderChild'
    ).mockRejectedValueOnce(new Error('spawn-token mint failed'))

    const id = await accept(sendParams('bookkeeping failed'))

    expect(await settled(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: "Codex couldn't restart: spawn-token mint failed."
    })
    expect(hostErrors).toContainEqual(
      expect.objectContaining({ message: 'spawn-token mint failed' })
    )
    expect(await errorStatuses()).toHaveLength(1)
  })

  it('exits the recovery stage a failed attempt latched before its delivery resumes it', async () => {
    await loseOwner()
    // What an acquisition whose exit could not be proven leaves behind: nobody's, but latched.
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, handoffStage: 'manual-recovery' }
    }))
    host.deps.probeOwner = async () => ({ outcome: 'pid-absent' })

    await accept(sendParams('latched owner'))

    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'live'
    })
  })

  it('adjudicates a lease this host has not reconciled before its delivery resumes it', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, unreconciled: true }
    }))

    // The send's start is the same serialized resume a hold runs, reconciliation first.
    await accept(sendParams('owner unverified'))

    await eventually(async () => expect(dispatch).toHaveBeenCalledOnce())
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      unreconciled: false,
      claimStatus: 'live'
    })
  })
})

// A pane keeps the fence of the last frame it read. An idle release and the restart after it
// each move the lease, so that fence can be several generations behind the one a write lands on.
describe('a write fenced to an owner the pane has not seen replaced', () => {
  it('delivers a send fenced to the owner an idle release retired', async () => {
    const seenFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await loseOwner()
    const params = sendParams('after the release')
    params.envelope.expectedRuntimeFence = seenFence

    const id = await accept(params)
    expect(await settled(id)).toMatchObject({ dispatchState: 'accepted' })

    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBeGreaterThan(seenFence + 1)
  })

  // Clients resend a refused message when the fence they hold moves. A failed start is a
  // rejected message now, never a refused send, and the pane keeps the fence it subscribed under.
  it("keeps the pane's fence on the rows a failed start publishes, and rejects the message", async () => {
    const seenFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const frames: AgentSessionSubscribeEvent[] = []
    await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
    await loseOwner()
    acquire.mockRejectedValueOnce(new Error('Not signed in'))
    const subscribed = frames.length

    const id = await accept(sendParams('while signed out'))

    expect(await settled(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining('Not signed in')
    })
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBeGreaterThan(seenFence + 1)
    const published = frames.slice(subscribed)
    expect(published.length).toBeGreaterThan(0)
    for (const frame of published) {
      expect(frame).toMatchObject({ fence: seenFence })
    }
  })

  it('admits a Stop and a send queued behind the cold start that replaced their owner', async () => {
    await loseOwner()
    const lostFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    let claimed = () => {}
    let release = () => {}
    const claim = new Promise<void>((resolve) => (claimed = resolve))
    const spawn = new Promise<void>((resolve) => (release = resolve))
    acquire.mockImplementationOnce(async (input) => {
      claimed()
      await spawn
      return spawnChild(input)
    })

    const firstParams = sendParams('starts the agent')
    const first = host.send(CALLER, firstParams)
    await claim
    const cancelFields = { turnId: 'turn-1' }
    const stop = host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: lostFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: cancelFields
        })
      },
      ...cancelFields
    })
    const late = sendParams('typed during the start')
    late.envelope.expectedRuntimeFence = lostFence - 1
    const second = host.send(CALLER, late)
    release()

    expect(await first).toMatchObject({ ok: true })
    expect(await stop).toMatchObject({ ok: true, replayed: false })
    expect(await second).toMatchObject({ ok: true, replayed: false })
    // The Stop withdrew the message its start held; the one typed after it is delivered.
    expect(await settled(late.envelope.clientOperationId)).toMatchObject({
      dispatchState: 'accepted'
    })
    expect(await submission(firstParams.envelope.clientOperationId)).toMatchObject({
      dispatchState: 'rejected'
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
