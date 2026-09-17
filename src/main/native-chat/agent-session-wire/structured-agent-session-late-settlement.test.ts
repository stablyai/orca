import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { DISPATCH_DOUBT_TURN_SETTLED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionLateSettlementResult } from './structured-agent-session-late-settlement'
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

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>

function accepted(): AgentSessionDispatchOutcome {
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
  }
}

function sendParams(text: string): {
  envelope: AgentSessionMutationEnvelope
  body: ReturnType<typeof hostTestMessage>
} {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

function submissions(): unknown {
  const state = host.history({ sessionId: SESSION, direction: 'tail' })
  return state.ok ? state.page.submissions : null
}

function heldSession(): { fence: number; journal: AgentSessionJournal } {
  return (
    (
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test inspects the host's private, already-attached session fixture.
      host as unknown as {
        sessions: Map<string, { fence: number; journal: AgentSessionJournal }>
      }
    ).sessions.get(SESSION)!
  )
}

function journal(): AgentSessionJournal {
  return heldSession().journal
}

async function appendTerminalTurn(turnId: string): Promise<void> {
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId, ordinal: 99 },
    { kind: 'turn', turnId, state: 'completed', startedAt: NOW - 10, completedAt: NOW },
    { fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-late-settle-'))
  resetHostTestOperationIds()
  dispatch = vi.fn(async () => accepted())
  closeSession = vi.fn(async () => true)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: vi.fn(async ({ fence }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
      releaseAcquisition: vi.fn(async () => true),
      dispatch,
      closeSession,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await host.close(SESSION)
  await rm(root, { recursive: true, force: true })
})

describe('settling a send the provider proves it received after the ack window', () => {
  it('publishes acceptance during a pending send and never reopens it for retry', async () => {
    let finishDispatch!: (outcome: AgentSessionDispatchOutcome) => void
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDispatch = resolve
        })
    )
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = host.subscribe({
      id: 'late-receipt',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const params = sendParams('echo before send completes')
    const pending = host.send(CALLER, params)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    try {
      await host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'early-echo' }
      })
      expect(events.at(-1)).toMatchObject({
        type: 'batch',
        batch: {
          submissions: [
            { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
          ]
        }
      })
    } finally {
      finishDispatch({ state: 'unknown', reason: 'ack timeout' })
      unsubscribe()
    }
    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('persists an echo received while the provider is closing', async () => {
    dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'ack timeout' })
    const params = sendParams('received just before shutdown')
    await host.send(CALLER, params)
    let settlement: Promise<StructuredAgentSessionLateSettlementResult> | undefined
    closeSession.mockImplementationOnce(async () => {
      settlement = host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'closing-echo' }
      })
      void settlement.catch(() => undefined)
      return true
    })

    await host.close(SESSION)
    await expect(settlement).resolves.toBe('settled')
    await host.revealSession(SESSION)
    expect(submissions()).toMatchObject([{ dispatchState: 'accepted' }])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('moves a durable unknown to accepted so nothing offers to send it again', async () => {
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const params = sendParams('sent while a turn was running')
    const first = await host.send(CALLER, params)
    expect(first).toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'late-uuid' }
    })

    expect(submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
    ])
    // The point of the fix: the client stops rendering Retry, and Retry is what
    // was delivering the message to the agent a second time.
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('settles a provider-cancelled queued send as rejected', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('queued behind the active turn')
    await host.send(CALLER, params)

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      state: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })

    expect(submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_CANCELLED
      }
    ])
  })

  it('accepts from the durable echo row when the direct settlement write fails', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('settle from provider echo')
    await host.send(CALLER, params)
    vi.spyOn(journal(), 'resolveDispatch').mockRejectedValueOnce(
      new Error('direct settlement write failed')
    )

    await expect(
      host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' }
      })
    ).rejects.toThrow('direct settlement write failed')
    await journal().appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' },
      params.body,
      { fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }
    )

    expect(submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'accepted',
        providerItemId: `claude:${THREAD}:echo-row`
      }
    ])
  })

  it('leaves an already accepted send alone', async () => {
    const params = sendParams('ordinary send')
    await host.send(CALLER, params)

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'a-different-uuid' }
    })

    expect(submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
    ])
  })

  it('ignores a live echo with no exact durable submission', async () => {
    const resolveDispatch = vi.spyOn(journal(), 'resolveDispatch')

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: 'foreign-client-id',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 9 }
    })

    expect(resolveDispatch).not.toHaveBeenCalled()
  })

  it('ignores an echo for a submission from an older runtime fence', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('stale provider echo')
    await host.send(CALLER, params)
    const session = heldSession()
    const originalFence = session.fence
    session.fence += 1
    const resolveDispatch = vi.spyOn(session.journal, 'resolveDispatch')
    try {
      await host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-old', ordinal: 1 }
      })
      expect(resolveDispatch).not.toHaveBeenCalled()
      expect(submissions()).toMatchObject([{ dispatchState: 'pending' }])
    } finally {
      session.fence = originalFence
    }
  })

  it('settles an exact send after its terminal lifecycle row becomes durable', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('owned by the completed turn')
    await host.send(CALLER, params)
    vi.spyOn(host, 'flushStreamedEvents').mockImplementationOnce(() => appendTerminalTurn('turn-1'))

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      state: 'unknown',
      reason: DISPATCH_DOUBT_TURN_SETTLED,
      recovered: true,
      turnId: 'turn-1'
    })

    expect(submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'unknown',
        reason: DISPATCH_DOUBT_TURN_SETTLED,
        recovered: true
      }
    ])
  })

  it('ignores owner-ended evidence until the exact terminal turn is durable', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('terminal row was not admitted')
    await host.send(CALLER, params)
    const resolveDispatch = vi.spyOn(journal(), 'resolveDispatch')

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      state: 'unknown',
      reason: DISPATCH_DOUBT_TURN_SETTLED,
      recovered: true,
      turnId: 'turn-not-durable'
    })

    expect(resolveDispatch).not.toHaveBeenCalled()
    expect(submissions()).toMatchObject([{ dispatchState: 'pending' }])
  })

  it('ignores a terminal turn from an older runtime fence', async () => {
    await appendTerminalTurn('turn-reused')
    const session = heldSession()
    session.fence += 1
    await session.journal.appendSubmission({
      clientMessageId: 'new-fence-send',
      payloadFingerprint: 'new-fence-fingerprint',
      body: hostTestMessage('new fence send'),
      fence: session.fence
    })
    await expect(
      host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: 'new-fence-send',
        state: 'unknown',
        reason: DISPATCH_DOUBT_TURN_SETTLED,
        recovered: true,
        turnId: 'turn-reused'
      })
    ).resolves.toBe('evidence-not-durable')
    expect(submissions()).toMatchObject([
      expect.objectContaining({ clientMessageId: 'new-fence-send', dispatchState: 'pending' })
    ])
  })

  it('ignores a session this host is not holding', async () => {
    await expect(
      host.settleLateDispatch({
        sessionId: 'session-that-is-not-attached',
        clientMessageId: 'whatever',
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'x' }
      })
    ).resolves.toBe('no-obligation')
  })
})
