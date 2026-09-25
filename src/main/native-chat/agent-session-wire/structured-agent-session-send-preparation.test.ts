// A send, or a hold, that finds the session's provider child gone, against the real host.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestLaunchDirectory,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
// Long enough that no release fires mid-test; whether one is pending is asserted directly.
const GRACE_MS = 60_000

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
    resolveLaunchDirectory: hostTestLaunchDirectory,
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    releaseGraceMs: GRACE_MS,
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

/** Every status row the chat shows, oldest first; none when the session is not even readable. */
function journalStatuses(): string[] {
  if (!host.hasSession(SESSION)) {
    return []
  }
  const history = host.history({ sessionId: SESSION, direction: 'tail' })
  return history.ok
    ? history.page.items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
    : []
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

    const result = await host.send(CALLER, sendParams('after the child died'))

    expect(result).toMatchObject({ ok: true, replayed: false })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('restarts the owner before the send is admitted, so the send is admitted once', async () => {
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

    await expect(host.send(CALLER, sendParams('ensure first'))).resolves.toMatchObject({
      ok: true,
      replayed: false
    })

    expect(order).toEqual(['acquire', 'admit'])
  })

  it('leaves a live owner alone', async () => {
    acquire.mockClear()

    await expect(host.send(CALLER, sendParams('owner is live'))).resolves.toMatchObject({
      ok: true
    })

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

    await host.send(CALLER, sendParams('into a cleared chat'))

    expect(acquire).not.toHaveBeenCalled()
  })

  it('renews the idle window on journal activity in an unheld session', async () => {
    await loseOwner()
    await expect(host.send(CALLER, sendParams('restart'))).resolves.toMatchObject({ ok: true })
    const arm = vi.spyOn(host['holds']['clock'], 'arm')

    await expect(host.send(CALLER, sendParams('more activity'))).resolves.toMatchObject({
      ok: true
    })

    expect(arm).toHaveBeenCalledWith(SESSION)
  })

  it('releases the restarted child on the usual clock only when no surface holds it', async () => {
    await loseOwner()
    await expect(host.send(CALLER, sendParams('nobody is watching'))).resolves.toMatchObject({
      ok: true
    })
    expect(host['holds'].isReleasePending(SESSION)).toBe(true)

    await host.close(SESSION)
    // A reading surface that does not itself restart the agent.
    await host.hold(SESSION, 'desktop-chat:1', { resume: false })
    await expect(host.send(CALLER, sendParams('the chat is open'))).resolves.toMatchObject({
      ok: true
    })
    expect(host['holds'].isReleasePending(SESSION)).toBe(false)
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

    await expect(host.send(CALLER, sendParams('after an exit'))).resolves.toMatchObject({
      ok: true
    })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('restarts nothing for a resend the journal already answers', async () => {
    const params = sendParams('sent once')
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
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
    await expect(host.send(CALLER, sendParams('sent once'))).resolves.toMatchObject({
      ok: true,
      replayed: false
    })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledTimes(2)
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

  it('rebases a send that arrives after the restart has already claimed the lease', async () => {
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

    const first = host.send(CALLER, sendParams('first'))
    await claim
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(lostFence + 1)
    const late = sendParams('second')
    late.envelope.expectedRuntimeFence = lostFence
    const second = host.send(CALLER, late)
    release()

    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('shares one restart between concurrent sends', async () => {
    await loseOwner()

    const results = await Promise.all([
      host.send(CALLER, sendParams('first')),
      host.send(CALLER, sendParams('second')),
      host.send(CALLER, sendParams('third'))
    ])

    expect(results.map((result) => result.ok)).toEqual([true, true, true])
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('shares one restart between a hold and a send that arrive in the same gap', async () => {
    await loseOwner()

    const [held, sent] = await Promise.allSettled([
      host.hold(SESSION, 'desktop-chat:1'),
      host.send(CALLER, sendParams('while the chat opens'))
    ])

    expect(held).toMatchObject({ status: 'fulfilled' })
    expect(sent).toMatchObject({ status: 'fulfilled', value: { ok: true } })
    expect(acquire).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(host['holds'].isHeld(SESSION)).toBe(true)
    expect(host['holds'].isReleasePending(SESSION)).toBe(false)
  })

  it('replays into a closed session without spawning anything', async () => {
    const params = sendParams('sent once')
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
    await loseOwner()

    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })

    // The journal was made readable for the answer; the record's lease was left as it was.
    expect(host.hasSession(SESSION)).toBe(true)
    expect(acquire).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    expect(host['holds'].isReleasePending(SESSION)).toBe(false)
  })

  it("refuses with the restart's own cause, in the answer and in the chat", async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in. Run codex login'))
    const params = sendParams('while signed out')

    const result = await host.send(CALLER, params)

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_owner_restart_failed',
        message: "Codex couldn't restart: Not signed in. Run codex login.",
        // The failed attach proved its child gone: nothing runs for this session.
        ownerVerdict: 'exited'
      }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(hostErrors).not.toEqual([])
    expect(
      agentSessionRefusalOperationState('agentSession.send', 'agent_session_owner_restart_failed')
    ).toBe('settled-rejected')
    // Refused before admission: the ledger holds nothing a resend would replay.
    expect(store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)).toBeNull()
    // The same status row a failed start leaves, so the reason outlives the error strip.
    expect(journalStatuses()).toEqual([
      'The provider stopped before it finished starting: Not signed in. Run codex login.'
    ])
  })

  it('restarts again for a Retry of the refused send, under its own id or a new one', async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in'))
    const params = sendParams('while signed out')
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed' }
    })

    // A client that resends the same id gets another attempt, and the chat no second row.
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed' }
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(journalStatuses()).toHaveLength(1)

    // The outbox's Retry rotates the id: also a fresh attempt.
    await expect(host.send(CALLER, sendParams('while signed out'))).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed' }
    })
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('restarts and delivers a later send once the cause clears', async () => {
    await loseOwner()
    acquire.mockRejectedValueOnce(new Error('Not signed in'))
    await expect(host.send(CALLER, sendParams('while signed out'))).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed' }
    })

    // The user signed in; nothing about the failed attempt is remembered.
    await expect(host.send(CALLER, sendParams('signed in now'))).resolves.toMatchObject({
      ok: true,
      replayed: false
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('suggests a new chat only when this host has nothing to restart the chat from', async () => {
    await loseOwner()
    acquire.mockRejectedValue(new Error('Not signed in'))
    const failed = await host.send(CALLER, sendParams('restart fails'))
    expect(failed).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_owner_restart_failed' }
    })
    expect(failed.ok ? '' : failed.refusal.message).not.toMatch(/new chat/)

    // The adapter cannot run this record where it lives: no retry would bring it back.
    host.deps.adapter.supportsLocation = () => false
    const unresumable = await host.send(CALLER, sendParams('cannot resume here'))

    expect(unresumable).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_owner_restart_failed',
        message:
          "Codex couldn't restart: This execution host cannot resume the requested structured agent session. Start a new chat to continue."
      }
    })
  })

  it('runs the send as the lease stands when the restart met a lease someone else is settling', async () => {
    await loseOwner()
    vi.spyOn(host['holds'], 'ensureProviderChild').mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'execution_owner_reconciling',
        message: 'Another runtime is still adjudicating this lease.'
      }
    })

    const result = await host.send(CALLER, sendParams('owner being settled'))

    // The ordinary lease check answers, retryably; nothing terminal and nothing in the chat.
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(journalStatuses()).toEqual([])
  })

  it('runs the send as the lease stands when the restart itself faults', async () => {
    await loseOwner()
    vi.spyOn(host['holds'], 'ensureProviderChild').mockRejectedValueOnce(
      new Error('spawn-token mint failed')
    )

    const result = await host.send(CALLER, sendParams('bookkeeping failed'))

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(hostErrors).toContainEqual(
      expect.objectContaining({ message: 'spawn-token mint failed' })
    )
    expect(journalStatuses()).toEqual([])
  })

  it('keeps a second surface holder taken during an auto-restart, and starts nothing for it', async () => {
    await host.hold(SESSION, 'desktop-chat:1')
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    acquire.mockClear()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const spawnChild = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      entered.resolve()
      await gate.promise
      return spawnChild(input)
    })

    // The held child exits: the host restarts it on its own, under the surface that holds it.
    const restarted = host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })
    await entered.promise
    const second = host.hold(SESSION, 'paired-phone:1')
    gate.resolve()
    await Promise.all([restarted, second])

    expect(acquire).toHaveBeenCalledOnce()
    expect(host['holds']['holders'].holderIds(SESSION)).toEqual([
      'desktop-chat:1',
      'paired-phone:1'
    ])
    expect(host['holds'].isReleasePending(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('puts the child of an auto-restart on the idle clock when its surface left mid-attach', async () => {
    await host.hold(SESSION, 'desktop-chat:1')
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    acquire.mockClear()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const spawnChild = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      entered.resolve()
      await gate.promise
      return spawnChild(input)
    })

    const restarted = host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: 'generation-1'
    })
    await entered.promise
    // The only surface leaves while the host is still spawning the child it asked for.
    host.release(SESSION, 'desktop-chat:1')
    gate.resolve()
    await restarted

    expect(acquire).toHaveBeenCalledOnce()
    expect(host['holds'].isHeld(SESSION)).toBe(false)
    // Nobody holds the child, so it goes on the same clock a departed surface would start.
    expect(host['holds'].isReleasePending(SESSION)).toBe(true)
    expect(hostErrors).toEqual([])
  })

  it('counts a queued restart as in flight from the moment it is asked for, so a quit drains it', async () => {
    const closeSession = vi.mocked(host.deps.adapter.closeSession!)
    acquire.mockClear()
    const gate = Promise.withResolvers<void>()
    closeSession.mockImplementationOnce(async () => {
      await gate.promise
      return true
    })
    const closing = host.close(SESSION)
    const hold = host.hold(SESSION, 'desktop-chat:1')
    let drained = false
    void host['tasks'].drainAttaches().then(() => {
      drained = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    // The hold waits its turn behind the close, and the quit's drain waits for the hold: the
    // child it is about to spawn must exist before the quit decides what to evict.
    expect(acquire).not.toHaveBeenCalled()
    expect(drained).toBe(false)

    gate.resolve()
    await Promise.all([closing, hold])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(acquire).toHaveBeenCalledOnce()
    expect(drained).toBe(true)
  })

  it('adjudicates a lease this host has not reconciled before a hold resumes it', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, unreconciled: true }
    }))
    host.deps.probeOwner = async () => ({ outcome: 'pid-absent' })

    await host.hold(SESSION, 'desktop-chat:1')

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      unreconciled: false,
      claimStatus: 'live'
    })
  })

  it('exits the recovery stage a failed attempt latched before a hold resumes', async () => {
    await loseOwner()
    // What an acquisition whose exit could not be proven leaves behind: nobody's, but latched.
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, handoffStage: 'manual-recovery' }
    }))
    host.deps.probeOwner = async () => ({ outcome: 'pid-absent' })

    await host.hold(SESSION, 'desktop-chat:1')

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      handoffStage: null,
      claimStatus: 'live'
    })
  })

  it('leaves a lease it cannot adjudicate alone', async () => {
    await loseOwner()
    await store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, unreconciled: true }
    }))

    const result = await host.send(CALLER, sendParams('owner unverifiable'))

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(acquire).not.toHaveBeenCalled()
  })
})
