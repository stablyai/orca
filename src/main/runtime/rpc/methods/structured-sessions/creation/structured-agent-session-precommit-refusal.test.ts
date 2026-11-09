import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
// Before attach, classify no-effects refusal; at/after attach, failure cannot prove no session exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { recordingStructuredAgentSessionLogger } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { agentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../structured-agent-session'
import './structured-agent-session-create'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: legacy create reads the empty ledger, calls attach and logs failures.
  return {
    attach,
    deps: {
      logger: recordingStructuredAgentSessionLogger().logger,
      store: { getOperationRow: vi.fn(() => null) }
    }
  } as unknown as StructuredAgentSessionHost
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
    // Fixtures pass capability admission so they exercise the pre-commit refusal boundary.
    getClientSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }),
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
  it('keeps a transcript read exception out of a coded create refusal', async () => {
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw agentSessionRefusalError(
          'agent_session_identity_required',
          { reason: 'transcriptUnreadable' },
          "ENOENT: no such file or directory, open '/Users/private/rollout-missing.jsonl'"
        )
      })
    })
    expect(refusalOf(response)).toMatchObject({
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      message: 'Orca cannot open a structured agent chat for this workspace.',
      createAttemptRefusedBeforeCommit: true
    })
    expect(attach).not.toHaveBeenCalled()
  })

  it('keeps private precommit faults out of a definitive public refusal', async () => {
    // The class no per-site conversion catches: an unresolvable worktree throws prose, not a code.
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw new Error('private-workspace-detail-sentinel')
      })
    })

    const refusal = refusalOf(response)
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
    expect(JSON.stringify(refusal)).not.toContain('private-workspace-detail-sentinel')
    expect(refusal).not.toHaveProperty('details')
    expect(attach).not.toHaveBeenCalled()
  })
})
