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
let requests = 0

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
  closeSession = vi.fn(async () => true)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      closeSession,
      dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
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
