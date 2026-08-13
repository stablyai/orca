import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import type { RpcRequest } from '../../../src/main/runtime/rpc/core'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../../src/main/runtime/rpc/methods/structured-agent-session'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { createMobileStructuredOutboxEntry } from '../session/mobile-structured-outbox-entry'
import {
  createMobileStructuredOperationId,
  mobileStructuredSendRequest
} from '../session/mobile-structured-mutation-envelope'
import { mobileStructuredCreateFingerprint } from '../session/mobile-structured-session-create'
import { connect } from './rpc-client'
import {
  MockWebSocket,
  mockSockets,
  originalWebSocket,
  sentRequest
} from './rpc-client-test-websocket'

vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }))
vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

function authenticate(socket: MockWebSocket): void {
  socket.open()
  socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
  socket.receive('encrypted:{"type":"e2ee_authenticated"}')
}

function advertisedCapabilities(socket: MockWebSocket): string[] {
  const auth = socket.sent
    .map((payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as Record<string, unknown>)
    .find((payload) => payload.type === 'e2ee_auth')
  return (auth?.clientCapabilities as string[] | undefined) ?? []
}

async function relayPairedRequest(
  socket: MockWebSocket,
  dispatcher: RpcDispatcher,
  method: string
): Promise<void> {
  const outgoing = sentRequest(socket, method)
  await dispatcher.dispatchStreaming(
    {
      id: outgoing.id,
      authToken: 'paired-token',
      method,
      params: outgoing.params
    } as RpcRequest,
    (response) => socket.receive(`encrypted:${response}`),
    {
      clientKind: 'mobile',
      clientCapabilities: advertisedCapabilities(socket),
      clientId: 'paired-device-1',
      connectionId: 'paired-connection-1'
    }
  )
}

describe('structured session RPC transport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('advertises structured agent sessions in encrypted authentication', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    const auth = socket.sent
      .map((payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as Record<string, unknown>)
      .find((payload) => payload.type === 'e2ee_auth')

    expect(auth).toEqual({
      type: 'e2ee_auth',
      deviceToken: 'token',
      clientCapabilities: ['agent-session.structured.v1', 'agent-session.structured.claude.v1']
    })
    client.close()
  })

  it('rebuilds a structured stream cursor when the transport reconnects', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const first = mockSockets[0]!
    first.open()
    first.receive(JSON.stringify({ type: 'e2ee_ready' }))
    first.receive('encrypted:{"type":"e2ee_authenticated"}')
    let sequence = 4
    client.subscribe(
      'agentSession.subscribe',
      { sessionId: 'session-a', cursor: { epoch: 'epoch-a', sequence } },
      () => {},
      {
        paramsForReconnect: () => ({
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence }
        })
      }
    )
    sequence = 9
    first.close()
    vi.advanceTimersByTime(500)
    const second = mockSockets[1]!
    second.open()
    second.receive(JSON.stringify({ type: 'e2ee_ready' }))
    second.receive('encrypted:{"type":"e2ee_authenticated"}')

    expect(sentRequest(second, 'agentSession.subscribe').params).toEqual({
      sessionId: 'session-a',
      cursor: { epoch: 'epoch-a', sequence: 9 }
    })
    client.close()
  })

  it('unsubscribes a structured stream by its request-scoped subscription id', () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
    socket.receive('encrypted:{"type":"e2ee_authenticated"}')
    const dispose = client.subscribe('agentSession.subscribe', { sessionId: 'session-a' }, () => {})
    const subscribe = sentRequest(socket, 'agentSession.subscribe')

    dispose()

    expect(sentRequest(socket, 'agentSession.unsubscribe').params).toEqual({
      sessionId: 'session-a',
      subscriptionId: subscribe.id
    })
    client.close()
  })

  it('creates then sends through the paired mobile transport and durable host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-mobile-paired-structured-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>(async () => ({
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread-paired',
        turnId: 'turn-1',
        ordinal: 1
      }
    }))
    const adapter: StructuredAgentSessionAdapter = {
      acquire: async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: Date.now(),
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: 'thread-paired' },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: Date.now()
        }
      }),
      dispatch,
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    }
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-paired'
    })
    setStructuredAgentSessionHost(host)
    const cleanups = new Map<string, () => void>()
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
      resolveStructuredAgentSessionCreateIntent: async () => ({
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree'
        },
        provider: 'codex',
        agent: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
        runtimeKind: 'native'
      }),
      ensureStructuredAgentSessionHost: async () => undefined,
      publishStructuredAgentSessionTab: vi.fn(),
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
      cleanupSubscription: (id: string) => cleanups.get(id)?.(),
      cleanupSubscriptionsByPrefix: () => undefined
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    authenticate(socket)
    const sessionId = 'mobile_paired'
    const worktree = 'id:workspace-1'
    try {
      expect(advertisedCapabilities(socket)).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
      expect(advertisedCapabilities(socket)).toContain(
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      )
      const createdPromise = client.sendRequest('agentSession.create', {
        envelope: {
          sessionId,
          clientOperationId: createMobileStructuredOperationId(
            () => '00000000-0000-4000-8000-000000000001'
          ),
          expectedRuntimeFence: null,
          payloadFingerprint: mobileStructuredCreateFingerprint({
            sessionId,
            worktree,
            agent: 'codex'
          })
        },
        worktree,
        agent: 'codex'
      })
      await Promise.resolve()
      await relayPairedRequest(socket, dispatcher, 'agentSession.create')
      const created = await createdPromise
      expect(created).toMatchObject({ ok: true, result: { ok: true } })
      const fence = (created as { result: { value: { fence: number } } }).result.value.fence
      const outboxEntry = createMobileStructuredOutboxEntry({
        clientMessageId: createMobileStructuredOperationId(
          () => '00000000-0000-4000-8000-000000000002'
        ),
        sessionId,
        text: 'paired hello',
        attachments: [],
        queuedAt: Date.now()
      })
      const sentPromise = client.sendRequest(
        'agentSession.send',
        mobileStructuredSendRequest(outboxEntry, fence)
      )
      await Promise.resolve()
      await relayPairedRequest(socket, dispatcher, 'agentSession.send')
      await expect(sentPromise).resolves.toMatchObject({ ok: true, result: { ok: true } })
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          clientMessageId: outboxEntry.clientMessageId,
          body: expect.objectContaining({ kind: 'message' })
        })
      )
    } finally {
      client.close()
      await host.flushAllStreamedEvents()
      setStructuredAgentSessionHost(null)
      await rm(root, { recursive: true, force: true })
    }
  })
})
