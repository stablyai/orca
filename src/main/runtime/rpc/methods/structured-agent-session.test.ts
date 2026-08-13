// The wire boundary: who may see `agentSession.*` at all, and what shapes it
// accepts once they can.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import {
  recordMobileClipboardImagePath,
  resetMobileClipboardImageProvenanceForTest
} from '../mobile-clipboard-image-provenance'

const SESSION = 'session-alpha'
const FINGERPRINT = 'f'.repeat(64)
const OPERATION = '1800000000000-00000000000000000000000000000001'

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    clientOperationId: OPERATION,
    expectedRuntimeFence: 1,
    payloadFingerprint: FINGERPRINT,
    ...overrides
  }
}

function sendParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope(),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...overrides
  }
}

function attachParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope({ expectedRuntimeFence: null }),
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    ...overrides
  }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

let hostCalls: Record<string, ReturnType<typeof vi.fn>>
let runtimeCalls: Record<string, ReturnType<typeof vi.fn>>

function hostStub(): StructuredAgentSessionHost {
  hostCalls = {
    attach: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      value: {
        sessionId: SESSION,
        fence: 1,
        snapshot: {
          sessionId: SESSION,
          cursor: { epoch: 'epoch-a', sequence: 0 },
          items: [],
          submissions: []
        },
        unconfirmedClientMessageIds: []
      }
    })),
    send: vi.fn(async (_caller, params) => {
      params.beforeRun?.()
      return { ok: true, replayed: false }
    }),
    invalidateEffectAuthorityForTrustedUserTurn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ ok: true, replayed: false })),
    respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
    setOption: vi.fn(async () => ({ ok: true, replayed: false })),
    requestHandoff: vi.fn(async () => ({ ok: true, replayed: false })),
    handoffStatus: vi.fn(async () => ({ owner: 'tui', phase: 'queued' })),
    readOptions: vi.fn(async () => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live' }
    })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    subscribe: vi.fn(() => () => undefined),
    unsubscribe: vi.fn()
  }
  return hostCalls as unknown as StructuredAgentSessionHost
}

function dispatcher(): RpcDispatcher {
  runtimeCalls = {
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (params) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      ...(params.effectAuthority ? { effectIsolation: 'local-structured-write' as const } : {}),
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: vi.fn()
  }
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn(),
    ...runtimeCalls
  }
  return new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
}

/** The reply path is the only one that carries a client's negotiated identity,
 *  which is exactly what the capability gate reads. */
async function call(
  method: string,
  params: unknown,
  client?: {
    clientId?: string
    clientKind?: 'mobile' | 'runtime'
    clientCapabilities?: string[]
  }
): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  await dispatcher().dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  const first = replies[0]
  if (!first) {
    throw new Error(`no reply for ${method}`)
  }
  return first
}

const STRUCTURED_CLIENT = {
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}
const DESKTOP_CLIENT = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

beforeEach(() => {
  setStructuredAgentSessionHost(hostStub())
  resetMobileClipboardImageProvenanceForTest()
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  resetMobileClipboardImageProvenanceForTest()
})

describe('capability gating', () => {
  it('advertises the capability without bumping the protocol version', () => {
    expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    // Additive methods do not break an old client; bumping would strand every
    // paired device that has not updated.
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
  })

  it('registers every structured method on the runtime manifest', () => {
    const names = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of STRUCTURED_AGENT_SESSION_METHODS) {
      expect(names).toContain(method.name)
    }
    expect(STRUCTURED_AGENT_SESSION_METHODS).toHaveLength(14)
  })

  it('hides the surface from a declared client that did not advertise it', async () => {
    const response = await call('agentSession.send', sendParams(), {
      clientKind: 'mobile',
      clientCapabilities: ['terminal.stream.v1']
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(hostCalls.send).not.toHaveBeenCalled()
  })

  it('rejects create intent before resolving host-owned fields for an old client', async () => {
    const worktree = 'id:workspace-1'
    const response = await call(
      'agentSession.create',
      {
        envelope: envelope({
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: SESSION,
            fields: { worktree, agent: 'codex' }
          })
        }),
        worktree,
        agent: 'codex'
      },
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
  })

  it('serves a client that advertised it', async () => {
    const response = await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.send).toHaveBeenCalledTimes(1)
  })

  it('rejects host-authoritative attach fields from a mobile caller', async () => {
    const response = await call('agentSession.create', attachParams(), STRUCTURED_CLIENT)

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('agent_session_create_intent_required') }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it('serves an in-process caller, which negotiates no capabilities at all', async () => {
    const response = await call('agentSession.send', sendParams())
    expect(response).toMatchObject({ ok: true })
  })

  it('invalidates writer authority only for a trusted local desktop user turn', async () => {
    await call('agentSession.send', sendParams(), DESKTOP_CLIENT)

    expect(hostCalls.invalidateEffectAuthorityForTrustedUserTurn).toHaveBeenCalledWith(SESSION)
    expect(
      hostCalls.invalidateEffectAuthorityForTrustedUserTurn.mock.invocationCallOrder[0]
    ).toBeLessThan(hostCalls.send.mock.invocationCallOrder[0])

    await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)
    await call('agentSession.send', sendParams())
    expect(hostCalls.invalidateEffectAuthorityForTrustedUserTurn).toHaveBeenCalledOnce()
  })

  it('reports the surface as absent when no host is installed', async () => {
    setStructuredAgentSessionHost(null)
    const response = await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)
    expect(response).toMatchObject({ ok: false })
  })
})

describe('method routing', () => {
  it('creates from mobile intent while the host resolves paths and provider identity', async () => {
    const worktree = 'id:workspace-1'
    const params = {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree, agent: 'codex' }
        })
      }),
      worktree,
      agent: 'codex'
    }
    const created = await call('agentSession.create', params, STRUCTURED_CLIENT)
    expect(created).toMatchObject({ ok: true, result: { ok: true } })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith(params)
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' }
      })
    )
    expect(hostCalls.attach.mock.calls[0]?.[1]).not.toHaveProperty('providerHandle')
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, activate: true })
    )
  })

  it('binds a local writer request to an effect-isolated session record', async () => {
    const worktree = 'id:workspace-1'
    const effectAuthority = 'local_structured_write' as const
    const params = {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree, agent: 'codex', effectAuthority }
        })
      }),
      worktree,
      agent: 'codex',
      effectAuthority
    }

    const created = await call('agentSession.create', params, DESKTOP_CLIENT)

    expect(created).toMatchObject({ ok: true, result: { ok: true } })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith(params)
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ effectIsolation: 'local-structured-write' })
    )
  })

  it('rejects writer creation and support checks from a remote client', async () => {
    const effectAuthority = 'local_structured_write' as const
    const worktree = 'id:workspace-1'
    const support = await call(
      'agentSession.createSupport',
      { worktree, agent: 'codex', effectAuthority },
      STRUCTURED_CLIENT
    )
    const create = await call(
      'agentSession.create',
      {
        envelope: envelope({
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: SESSION,
            fields: { worktree, agent: 'codex', effectAuthority }
          })
        }),
        worktree,
        agent: 'codex',
        effectAuthority
      },
      STRUCTURED_CLIENT
    )

    expect(support).toMatchObject({
      ok: false,
      error: { message: 'local_structured_write_requires_local_desktop_renderer' }
    })
    expect(create).toMatchObject({
      ok: false,
      error: { message: 'local_structured_write_requires_local_desktop_renderer' }
    })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
  })

  it('separates create from ensure by the fence the client may declare', async () => {
    const created = await call('agentSession.create', attachParams())
    expect(created).toMatchObject({ ok: true })

    const fenced = await call('agentSession.create', attachParams({ envelope: envelope() }))
    expect(fenced).toMatchObject({ ok: false })

    const ensured = await call('agentSession.ensure', attachParams({ envelope: envelope() }))
    expect(ensured).toMatchObject({ ok: true })
  })

  it('tags the prompt kind from the method name, not from the client', async () => {
    const params = {
      envelope: envelope(),
      itemId: 'item-1',
      expectedRevision: 1,
      optionId: 'allow'
    }
    await call('agentSession.respondToApproval', params, STRUCTURED_CLIENT)
    await call('agentSession.respondToQuestion', params, STRUCTURED_CLIENT)
    expect(hostCalls.respondToPrompt.mock.calls.map((invocation) => invocation[1].kind)).toEqual([
      'approval',
      'question'
    ])
  })

  it('routes a mobile reverse request through the host-owned handoff coordinator', async () => {
    const params = {
      envelope: envelope(),
      direction: 'to-native',
      mode: 'after-turn',
      action: 'start'
    }
    const response = await call('agentSession.requestHandoff', params, {
      ...STRUCTURED_CLIENT,
      clientId: 'mobile-device-a'
    })

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.requestHandoff).toHaveBeenCalledWith({ callerKey: 'mobile-device-a' }, params)
  })

  it('accepts manual proof recovery at the RPC boundary', async () => {
    const params = {
      envelope: envelope(),
      direction: 'to-tui',
      mode: 'now',
      action: 'recover'
    }

    await expect(call('agentSession.requestHandoff', params)).resolves.toMatchObject({ ok: true })
    expect(hostCalls.requestHandoff).toHaveBeenCalledWith(
      { callerKey: 'trusted-local:runtime' },
      params
    )
  })
})

describe('mobile image provenance', () => {
  const path = '/tmp/orca-paste-image.png'
  const mobileClient = (clientId: string) => ({ ...STRUCTURED_CLIENT, clientId })
  const imageParams = (block: { type: 'image-ref'; path?: string; url?: string }) =>
    sendParams({
      body: { kind: 'message', role: 'user', blocks: [block] }
    })

  it('accepts a same-client upload across retries without consuming provenance', async () => {
    recordMobileClipboardImagePath('device-a', path)

    await expect(
      call('agentSession.send', imageParams({ type: 'image-ref', path }), mobileClient('device-a'))
    ).resolves.toMatchObject({ ok: true })
    await expect(
      call('agentSession.send', imageParams({ type: 'image-ref', path }), mobileClient('device-a'))
    ).resolves.toMatchObject({ ok: true })
    expect(hostCalls.send).toHaveBeenCalledTimes(2)
  })

  it('rejects forged, cross-client, and URL image references from mobile', async () => {
    recordMobileClipboardImagePath('device-a', path)

    const forged = await call(
      'agentSession.send',
      imageParams({ type: 'image-ref', path: '/etc/private.png' }),
      mobileClient('device-a')
    )
    const crossClient = await call(
      'agentSession.send',
      imageParams({ type: 'image-ref', path }),
      mobileClient('device-b')
    )
    const url = await call(
      'agentSession.send',
      imageParams({ type: 'image-ref', url: 'https://example.com/image.png' }),
      mobileClient('device-a')
    )

    for (const response of [forged, crossClient, url]) {
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('agent_session_image_untrusted') }
      })
    }
    expect(hostCalls.send).toHaveBeenCalledTimes(3)
  })

  it('keeps trusted in-process image paths unchanged', async () => {
    const response = await call(
      'agentSession.send',
      imageParams({ type: 'image-ref', path: '/trusted/local/image.png' })
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.send).toHaveBeenCalledTimes(1)
  })
})

describe('parameter validation', () => {
  const rejects = async (method: string, params: unknown): Promise<void> => {
    const response = await call(method, params, STRUCTURED_CLIENT)
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  }

  it('rejects an unknown key rather than dropping it', async () => {
    await rejects('agentSession.send', { ...sendParams(), replyToItemId: 'item-1' })
    await rejects('agentSession.send', {
      ...sendParams(),
      envelope: { ...envelope(), priority: 'high' }
    })
  })

  it('refuses to let a client author anything but a user turn', async () => {
    await rejects(
      'agentSession.send',
      sendParams({
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] }
      })
    )
    await rejects(
      'agentSession.send',
      sendParams({
        body: { kind: 'message', role: 'user', blocks: [{ type: 'tool-call', name: 'Bash' }] }
      })
    )
  })

  it('rejects a journal-only opaque provider handle', async () => {
    await rejects(
      'agentSession.create',
      attachParams({ providerHandle: { kind: 'opaque', agent: 'codex', value: 'thread-1' } })
    )
  })

  it('requires a sha256 fingerprint and a positive fence', async () => {
    await rejects(
      'agentSession.send',
      sendParams({ envelope: envelope({ payloadFingerprint: 'f' }) })
    )
    await rejects(
      'agentSession.send',
      sendParams({ envelope: envelope({ payloadFingerprint: 'F'.repeat(64) }) })
    )
    await rejects(
      'agentSession.send',
      sendParams({ envelope: envelope({ expectedRuntimeFence: 0 }) })
    )
  })

  it('requires the item revision on a prompt answer', async () => {
    await rejects('agentSession.respondToApproval', {
      envelope: envelope(),
      itemId: 'item-1',
      optionId: 'allow'
    })
  })

  it('bounds a history page and validates its cursor', async () => {
    await rejects('agentSession.history', {
      sessionId: SESSION,
      direction: 'tail',
      limit: 100_000
    })
    await rejects('agentSession.history', { sessionId: SESSION, direction: 'sideways' })
    await rejects('agentSession.history', {
      sessionId: SESSION,
      direction: 'after',
      cursor: { epoch: 'epoch-1', sequence: -1 }
    })
  })

  it('accepts a well-formed history request', async () => {
    const response = await call(
      'agentSession.history',
      {
        sessionId: SESSION,
        direction: 'after',
        cursor: { epoch: 'epoch-1', sequence: 4 },
        limit: 40
      },
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({ ok: true })
  })
})
