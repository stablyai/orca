// The wire half of a session's lifetime: who takes a hold, and what happens when they vanish.
//
// Run against the REAL subscription registry rather than a stub, because the backstop being tested
// IS that registry's connection sweep — a stubbed `registerSubscriptionCleanup` would prove that
// the handler called a function, which is not the claim.

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
const GRACE_MS = 5
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
      dispatch: async () => ({
        state: 'rejected',
        reason: 'unused',
        rejection: { kind: 'providerRejected' }
      }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    releaseGraceMs: GRACE_MS,
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

describe('a client that holds a session', () => {
  it('keeps the provider child while the hold stands', async () => {
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true })

    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('releases it when the client says so', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })

    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true })

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('releases its hold and cleanup after the setting is disabled', async () => {
    const release = vi.spyOn(host, 'release')
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    structuredNativeChatEnabled = false

    expect(
      await call('agentSession.release', { sessionId: SESSION, holderId: 'chat-1' })
    ).toMatchObject({ ok: true })
    const releaseCallsAfterRpc = release.mock.calls.length
    runtime.cleanupSubscriptionsForConnection(CONNECTION)

    expect(releaseCallsAfterRpc).toBe(2)
    expect(release).toHaveBeenCalledTimes(releaseCallsAfterRpc)
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not report success when no provider child can be acquired', async () => {
    const response = await call('agentSession.hold', {
      sessionId: 'session-missing',
      holderId: 'chat-missing'
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_identity_required' }
    })
    expect(host.isHeld('session-missing')).toBe(false)
  })
})

describe('a client that disappears without cleanup', () => {
  it('shares one child with a same-ID replacement that arrives while the first hold resumes', async () => {
    await host.close(SESSION)
    await host.restoreReadableSessions()
    closeSession.mockClear()
    acquire.mockClear()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const spawnChild = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      entered.resolve()
      await gate.promise
      return spawnChild(input)
    })
    try {
      const params = { sessionId: SESSION, holderId: 'same-chat' }
      const first = call('agentSession.hold', params)
      await entered.promise
      // Re-registering the cleanup id released the first hold; the replacement waits its turn
      // behind the first hold's attach and finds the child it made.
      const replacement = call('agentSession.hold', params)
      gate.resolve()

      expect(await first).toMatchObject({ ok: true })
      expect(await replacement).toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledOnce()
      expect(host.isHeld(SESSION)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 4))
      expect(closeSession).not.toHaveBeenCalled()

      runtime.cleanupSubscriptionsForConnection(CONNECTION)
      await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
      expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    } finally {
      gate.resolve()
    }
  })

  it('lets a same-ID replacement make its own attempt when the first hold fails to acquire', async () => {
    await host.close(SESSION)
    await host.restoreReadableSessions()
    closeSession.mockClear()
    acquire.mockClear()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    acquire.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new Error('acquisition failed')
    })
    try {
      const params = { sessionId: SESSION, holderId: 'same-chat' }
      const first = call('agentSession.hold', params)
      await entered.promise
      const replacement = call('agentSession.hold', params)
      gate.resolve()

      expect(await first).toMatchObject({ ok: false })
      // One attempt per hold: the replacement's own succeeds, and the holder it re-took stands.
      const replaced = await replacement
      expect(replaced, JSON.stringify(replaced)).toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(host.isHeld(SESSION)).toBe(true)
      expect(closeSession).not.toHaveBeenCalled()

      runtime.cleanupSubscriptionsForConnection(CONNECTION)
      await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
      expect(closeSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    } finally {
      gate.resolve()
    }
  })

  it('still releases the session when its transport closes', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })

    runtime.cleanupSubscriptionsForConnection(CONNECTION)

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not release a hold another connection is still holding', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    await dispatcher.dispatchStreaming(
      {
        id: 'request-other',
        authToken: 'token',
        method: 'agentSession.hold',
        params: { sessionId: SESSION, holderId: 'chat-1' }
      },
      () => {},
      { ...CLIENT, clientId: 'device-2', connectionId: 'connection-2' }
    )

    runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('does not let an old connection sweep release its same-document replacement', async () => {
    await call('agentSession.hold', { sessionId: SESSION, holderId: 'chat-1' })
    await dispatcher.dispatchStreaming(
      {
        id: 'request-replacement',
        authToken: 'token',
        method: 'agentSession.hold',
        params: { sessionId: SESSION, holderId: 'chat-1' }
      },
      () => {},
      { ...CLIENT, connectionId: 'connection-2' }
    )

    runtime.cleanupSubscriptionsForConnection(CONNECTION)
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))

    expect(closeSession).not.toHaveBeenCalled()
    expect(host.hasSession(SESSION)).toBe(true)

    runtime.cleanupSubscriptionsForConnection('connection-2')
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
  })

  it('releases a desktop subscription when its renderer transport dies', async () => {
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
    expect(host.isHeld(SESSION)).toBe(true)

    transport.abort()

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('unsubscribes and releases stream retention after the setting is disabled', async () => {
    await dispatcher.dispatchStreaming(
      {
        id: 'stream-disabled-cleanup',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      () => {},
      CLIENT
    )
    expect(host.isHeld(SESSION)).toBe(true)
    structuredNativeChatEnabled = false

    expect(
      await call('agentSession.unsubscribe', {
        sessionId: SESSION,
        subscriptionId: 'stream-disabled-cleanup'
      })
    ).toMatchObject({ ok: true })

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(closeSession).toHaveBeenCalledWith(SESSION)
  })

  it('does not let a stream alone resume a released session', async () => {
    await host.close(SESSION)
    expect(host.hasSession(SESSION)).toBe(false)
    await host.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')

    await dispatcher.dispatchStreaming(
      {
        id: 'request-subscribe',
        authToken: 'token',
        method: 'agentSession.subscribe',
        params: { sessionId: SESSION }
      },
      () => {},
      CLIENT
    )

    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })
})
