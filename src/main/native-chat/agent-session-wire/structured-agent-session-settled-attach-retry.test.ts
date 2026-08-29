// What a client's retry sees around a failed attach settlement: a crash between
// reserve and settlement replays into the original reservation, and a settled
// failure refuses sends without ever re-dispatching on the user's behalf.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type * as DurableFileWrite from '../../durable-file-write'
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

const publishFault = vi.hoisted(() => ({ failOnPublish: 0, publishCount: 0 }))

vi.mock('../../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    renameDurable: async (tmpPath: string, finalPath: string) => {
      if (finalPath.endsWith('agent-sessions.json')) {
        publishFault.publishCount += 1
      }
      if (
        finalPath.endsWith('agent-sessions.json') &&
        publishFault.publishCount === publishFault.failOnPublish
      ) {
        throw new Error('simulated crash before failed-settlement publish')
      }
      return actual.renameDurable(tmpPath, finalPath)
    }
  }
})

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

function accepted(): AgentSessionDispatchOutcome {
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    releaseAcquisition,
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }
}

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-settled-attach-retry-'))
  publishFault.failOnPublish = 0
  publishFault.publishCount = 0
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  releaseAcquisition = vi.fn(async () => true)
  dispatch = vi.fn(async () => accepted())
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  publishFault.failOnPublish = 0
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('settled attach retry', () => {
  it('settles a post-acquisition journal failure and retries without a restart', async () => {
    const historyFilePath = vi
      .fn<NonNullable<StructuredAgentSessionAdapter['historyFilePath']>>()
      .mockRejectedValueOnce(new Error('journal path unavailable'))
      .mockResolvedValue(null)
    host = new StructuredAgentSessionHost({
      store,
      adapter: { ...adapter(), historyFilePath },
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    const first = hostTestAttachParams(null)

    await expect(host.attach(CALLER, first)).rejects.toThrow('journal path unavailable')
    expect(releaseAcquisition).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      runtimeFence: 2
    })
    expect(
      store.listOperationRows().find((row) => row.operationId === first.envelope.clientOperationId)
        ?.outcome
    ).toMatchObject({ status: 'failed' })

    await expect(host.attach(CALLER, hostTestAttachParams(2))).resolves.toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 3
    })
  })

  it('continues a safe same-host pending replay with the reserved token', async () => {
    const spawnTokens: string[] = []
    acquire.mockImplementation(async ({ fence, spawnToken }) => {
      spawnTokens.push(spawnToken)
      if (spawnTokens.length === 1) {
        throw new Error('reply lost')
      }
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    })
    const mintSpawnToken = vi.fn(() => 'spawn-safe')
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken,
      now: () => NOW
    })
    const params = hostTestAttachParams(null)
    publishFault.failOnPublish = 2

    await expect(host.attach(CALLER, params)).rejects.toThrow(
      'agent session acquisition failure settlement failed'
    )
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(mintSpawnToken).toHaveBeenCalledOnce()
    expect(spawnTokens).toEqual(['spawn-safe', 'spawn-safe'])
  })

  it('fences a crash-interrupted reservation replay until positive recovery', async () => {
    const spawnTokens: string[] = []
    acquire.mockImplementation(async ({ fence, spawnToken }) => {
      spawnTokens.push(spawnToken)
      if (spawnTokens.length === 1) {
        throw new Error('reply lost')
      }
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    })
    let token = 0
    const mintSpawnToken = vi.fn(() => `spawn-${++token}`)
    let reservationUnused = false
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken,
      probeOwner: async () =>
        reservationUnused
          ? { outcome: 'reservation-unused' }
          : { outcome: 'indeterminate', reason: 'spawn token scan unavailable' },
      now: () => NOW
    })
    const params = hostTestAttachParams(null)
    publishFault.failOnPublish = 2

    await expect(host.attach(CALLER, params)).rejects.toThrow(
      'agent session acquisition failure settlement failed'
    )
    expect(publishFault.publishCount).toBe(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      runtimeFence: 1,
      reservedSpawnToken: 'spawn-1',
      ownerProcess: null
    })

    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken,
      probeOwner: async () =>
        reservationUnused
          ? { outcome: 'reservation-unused' }
          : { outcome: 'indeterminate', reason: 'spawn token scan unavailable' },
      now: () => NOW
    })

    const refused = await host.attach(CALLER, params)
    if (refused.ok) {
      throw new Error('expected the replayed reservation to stay fenced')
    }
    expect(refused.refusal.code).toBe('agent_session_ownership_unknown')
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(releaseAcquisition).toHaveBeenCalledTimes(1)
    expect(mintSpawnToken).toHaveBeenCalledTimes(1)
    expect(spawnTokens).toEqual(['spawn-1'])
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'manual-recovery',
      runtimeFence: 1,
      reservedSpawnToken: 'spawn-1',
      ownerProcess: null
    })
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
        ?.outcome
    ).toEqual({ status: 'pending' })

    reservationUnused = true
    await host.hold(SESSION, 'desktop-chat:retry')
    expect(mintSpawnToken).toHaveBeenCalledTimes(2)
    expect(spawnTokens).toEqual(['spawn-1', 'spawn-2'])
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeKind: 'native',
      runtimeFence: 3,
      handoffStage: null,
      handoffOperationId: null,
      ownerProcess: { spawnToken: 'spawn-2' }
    })
  })

  it('restores an unknown submission without redispatch before a distinct send', async () => {
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('possibly delivered')
    const unknownParams = {
      envelope: envelope('agentSession.send', { body }),
      body
    }
    const first = await host.send(CALLER, unknownParams)
    expect(first).toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })

    await host.flushAllStreamedEvents()
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-restarted',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW
    })
    await host.restoreReadableSessions()
    await host.hold(SESSION, 'desktop-chat:restart')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 3
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    const newBody = hostTestMessage('are you there?')
    const sent = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: newBody }),
      body: newBody
    })
    if (!sent.ok) {
      throw new Error(`unexpected restored send refusal: ${sent.refusal.message}`)
    }
    expect(dispatch).toHaveBeenCalledTimes(2)
    const restoredHistory = host.history({ sessionId: SESSION, direction: 'tail' })
    if (!restoredHistory.ok) {
      throw new Error(`unexpected restored history reset: ${restoredHistory.reset}`)
    }
    expect(
      restoredHistory.page.submissions.find(
        (submission) => submission.clientMessageId === unknownParams.envelope.clientOperationId
      )?.dispatchState
    ).toBe('unknown')

    const explicitRetry = await host.send(CALLER, {
      ...unknownParams,
      envelope: {
        ...unknownParams.envelope,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 3
      },
      retryUnknown: true
    })
    expect(explicitRetry).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('records proven acquisition cleanup as durable death evidence', async () => {
    acquire.mockRejectedValueOnce(new Error('resume rejected'))

    await expect(host.attach(CALLER, hostTestAttachParams(null))).rejects.toThrow('resume rejected')

    expect(releaseAcquisition).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'acquisition cleanup proved no provider child remains'
      }
    })
  })
})
