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
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
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
    let settlement: Promise<void> | undefined
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
    await expect(settlement).resolves.toBeUndefined()
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

  it('ignores a session this host is not holding', async () => {
    await expect(
      host.settleLateDispatch({
        sessionId: 'session-that-is-not-attached',
        clientMessageId: 'whatever',
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'x' }
      })
    ).resolves.toBeUndefined()
  })
})
