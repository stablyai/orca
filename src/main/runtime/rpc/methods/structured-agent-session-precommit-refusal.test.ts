// The create route's pre-commit boundary: a failure before `attach` must reach the client as a
// refusal it can classify, and a failure at or after `attach` must not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../shared/agent-session-definitive-refusal'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const SESSION = 'session-alpha'
const OPERATION = '1800000000000-00000000000000000000000000000001'
const WORKTREE = 'id:workspace-1'

const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

function createParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION,
        fields: { worktree: WORKTREE, agent: 'codex' }
      }),
      ...(overrides.envelope as Record<string, unknown> | undefined)
    },
    worktree: WORKTREE,
    agent: 'codex'
  }
}

let attach: ReturnType<typeof vi.fn>

function hostStub(): StructuredAgentSessionHost {
  attach = vi.fn(async () => ({
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 0 },
    value: { sessionId: SESSION, fence: 1, page: {}, unconfirmedClientMessageIds: [] }
  }))
  return { attach } as unknown as StructuredAgentSessionHost
}

const resolvedIntent = {
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  agent: 'codex',
  accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
  runtimeKind: 'native'
}

async function create(
  runtimeOverrides: Record<string, unknown> = {},
  params: unknown = createParams()
): Promise<RpcResponse> {
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn(),
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (input: { envelope: unknown }) => ({
      envelope: input.envelope,
      ...resolvedIntent
    })),
    publishStructuredAgentSessionTab: vi.fn(async () => undefined),
    ...runtimeOverrides
  }
  const replies: RpcResponse[] = []
  await new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  }).dispatchStreaming(
    { id: 'request-1', authToken: 'token', method: 'agentSession.create', params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    STRUCTURED_CLIENT
  )
  const first = replies[0]
  if (!first) {
    throw new Error('no reply for agentSession.create')
  }
  return first
}

/** The refusal a client can act on, or null when the reply was not one. */
function refusalOf(response: RpcResponse): { code: string; message: string } | null {
  if (!response.ok) {
    return null
  }
  const result = response.result as { ok: boolean; refusal?: { code: string; message: string } }
  return result.ok ? null : (result.refusal ?? null)
}

beforeEach(() => {
  setStructuredAgentSessionHost(hostStub())
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

describe('a create refused before it commits', () => {
  it('answers a code-carrying refusal as a definitive envelope', async () => {
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw new Error('structured_agent_session_unsupported')
      })
    })

    const refusal = refusalOf(response)
    expect(refusal?.code).toBe('structured_agent_session_unsupported')
    expect(refusal?.message).toContain('structured agent chat')
    expect(refusal?.message).not.toContain('Codex')
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
    expect(attach).not.toHaveBeenCalled()
  })

  it('answers a code-less failure as a definitive envelope too, keeping the cause in the message', async () => {
    // The class no per-site conversion catches: an unresolvable worktree throws prose, not a code.
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw new Error('No worktree matches id:workspace-1')
      })
    })

    const refusal = refusalOf(response)
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
    expect(refusal?.message).toContain('structured agent chat')
    expect(refusal?.message).not.toContain('Codex')
    expect(refusal?.message).toContain('No worktree matches id:workspace-1')
    expect(attach).not.toHaveBeenCalled()
  })

  it('answers a host that will not install as a definitive envelope', async () => {
    setStructuredAgentSessionHost(null)

    const response = await create({
      ensureStructuredAgentSessionHost: vi.fn(async () => {
        throw new Error('EACCES: could not open the session store')
      })
    })

    const refusal = refusalOf(response)
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
    expect(refusal?.message).toContain('could not open the session store')
  })

  it('answers a missing host as a definitive envelope rather than a thrown code', async () => {
    setStructuredAgentSessionHost(null)

    const response = await create()

    const refusal = refusalOf(response)
    expect(refusal?.code).toBe('structured_agent_session_unsupported')
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
  })

  it('still refuses a fingerprint conflict with its own code, not a pre-commit one', async () => {
    const response = await create(
      {},
      createParams({ envelope: { payloadFingerprint: 'a'.repeat(64) } })
    )

    expect(refusalOf(response)?.code).toBe('agent_session_operation_conflict')
    expect(attach).not.toHaveBeenCalled()
  })
})

describe('the boundary the envelope stops at', () => {
  it('leaves a failure at attach unknown, because it may have committed', async () => {
    attach.mockRejectedValueOnce(new Error('attach exploded'))

    const response = await create()

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(refusalOf(response)).toBeNull()
  })

  it('leaves a committed create whose tab could not be published unknown', async () => {
    const response = await create({
      publishStructuredAgentSessionTab: vi.fn(async () => {
        throw new Error('publish failed')
      })
    })

    const refusal = refusalOf(response)
    expect(refusal?.code).toBe('agent_session_operation_unknown')
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(false)
  })

  it('keeps hiding the surface from a client that never advertised it', async () => {
    const replies: RpcResponse[] = []
    await new RpcDispatcher({
      runtime: { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: STRUCTURED_AGENT_SESSION_METHODS
    }).dispatchStreaming(
      {
        id: 'request-1',
        authToken: 'token',
        method: 'agentSession.create',
        params: createParams()
      },
      (raw) => replies.push(JSON.parse(raw) as RpcResponse),
      { clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(replies[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('keeps a client-declared fence a programming error, not a refusal', async () => {
    const response = await create({}, createParams({ envelope: { expectedRuntimeFence: 1 } }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_invalid' }
    })
  })
})
