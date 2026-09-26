// `agentSession.hold` / `release` are kept answering for clients that still send them, and do
// nothing else: a view never starts or keeps an agent.
//
// Run against the REAL subscription registry rather than a stub, because the claim includes that a
// connection closing runs nothing hold-related — a stubbed registry could not show that.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const CONNECTION = 'connection-1'
const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: CONNECTION
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let requests = 0
let structuredNativeChatEnabled = true

async function call(method: string, params: unknown): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
  return replies[0] as RpcResponse
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-hold-wire-'))
  resetHostTestOperationIds()
  requests = 0
  structuredNativeChatEnabled = true
  closeSession = vi.fn(async () => true)
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      // A failed acquisition is proven gone, as the real adapters prove it; without this an
      // acquire that throws leaves an unverifiable owner nothing may replace.
      releaseAcquisition: vi.fn(async () => true),
      closeSession,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  setStructuredAgentSessionHost(host)
  runtime = new OrcaRuntimeService()
  // The structured surface is settings-gated for every caller, in-process included.
  vi.spyOn(runtime, 'getClientSettings').mockImplementation(
    () =>
      ({ experimentalStructuredNativeChat: structuredNativeChatEnabled }) as ReturnType<
        OrcaRuntimeService['getClientSettings']
      >
  )
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
  expect(await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('the hold surface, for clients that still call it', () => {
  it('answers a hold without starting an agent or registering a cleanup', async () => {
    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
    const registered = vi.spyOn(runtime, 'registerOwnedSubscriptionCleanup')
    const acquiresBefore = acquire.mock.calls.length

    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true, result: { held: true } })

    expect(acquire.mock.calls.length).toBe(acquiresBefore)
    expect(registered).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('answers a release without stopping anything, and a connection close runs nothing', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })

    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true, result: { released: true } })
    runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('refuses a hold once the setting is off, and still answers a release', async () => {
    structuredNativeChatEnabled = false

    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: false })
    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true, result: { released: true } })
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('answers a hold even when no agent could be started', async () => {
    await host.close(SESSION)
    acquire.mockRejectedValue(new Error('provider unavailable'))
    const acquiresBefore = acquire.mock.calls.length

    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true, result: { held: true } })
    expect(acquire.mock.calls.length).toBe(acquiresBefore)
  })
})

describe('a stream', () => {
  it('reads a closed conversation without starting its agent', async () => {
    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
    const acquiresBefore = acquire.mock.calls.length
    const frames: unknown[] = []

    await dispatcher.dispatchStreaming(
      {
        id: 'request-subscribe',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      (raw) => frames.push(JSON.parse(raw)),
      CLIENT
    )

    expect(frames).toContainEqual(
      expect.objectContaining({ result: expect.objectContaining({ type: 'snapshot' }) })
    )
    expect(acquire.mock.calls.length).toBe(acquiresBefore)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('keeps nothing alive when its transport dies', async () => {
    const transport = new AbortController()
    await dispatcher.dispatchStreaming(
      {
        id: 'desktop-subscription',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      () => {},
      {
        signal: transport.signal,
        clientId: 'desktop-renderer',
        clientKind: 'runtime',
        clientCapabilities: CLIENT.clientCapabilities
      }
    )

    transport.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The idle sweep, not a departing reader, is what stops an agent.
    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })
})
