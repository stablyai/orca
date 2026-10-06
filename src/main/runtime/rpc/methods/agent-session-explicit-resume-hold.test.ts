// An explicit terminal resume is refused while a structured chat still holds that conversation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionRequest } from '../../../../shared/agent-session-host-authority'
import type { AgentSessionLease, AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandle
} from '../../../../shared/agent-session-provider-handle'
import {
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../../shared/agent-session-wire-refusals'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { AGENT_SESSION_METHODS } from './agent-session'
import {
  assertExplicitResumeConversationUnowned,
  withAgentSessionConversationGate,
  type StructuredRecordHost
} from './agent-session-explicit-resume-hold'

const CLAUDE_CONVERSATION: AgentSessionProviderHandle = {
  provider: 'claude',
  sessionId: 'provider-session-alpha-1',
  leafUuid: null
}
const LIVE = agentSessionLeaseFixture()
const EXITED = agentSessionLeaseFixture({
  claimStatus: 'released',
  ownerProcess: null,
  reservedSpawnToken: null,
  deathEvidence: { kind: 'exit-observed', detail: 'the agent was stopped', observedAt: 1 }
})
const UNVERIFIABLE = agentSessionLeaseFixture({ claimStatus: 'reserved', ownerProcess: null })

function recordHolding(
  handle: AgentSessionProviderHandle,
  lease: AgentSessionLease = LIVE
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(lease),
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: lease.runtimeFence,
        observedAt: 1_000,
        handle
      }
    ]
  }
}

function recordForkedFrom(
  from: AgentSessionProviderHandle,
  to: AgentSessionProviderHandle
): AgentSessionRecord {
  const base = agentSessionRecordFixture(LIVE)
  return {
    ...base,
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: LIVE.runtimeFence,
        observedAt: 1_000,
        handle: from
      },
      {
        linkId: 'link-2',
        origin: 'forked',
        mintedAtFence: LIVE.runtimeFence,
        observedAt: 2_000,
        handle: to,
        forkedFromKey: agentSessionProviderHandleKey(from)
      }
    ]
  }
}

function hostHolding(records: AgentSessionRecord[]): StructuredRecordHost {
  return { deps: { store: { listRecords: () => records } } }
}

function explicitResume(agent: 'claude' | 'codex', id: string): RuntimeEnsureAgentSessionRequest {
  return {
    kind: 'explicit',
    worktree: 'id:worktree-1',
    agent,
    providerSession: { key: 'session_id', id }
  }
}

function refusalFrom(run: () => void): AgentSessionRefusalError {
  try {
    run()
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal')
}

describe('assertExplicitResumeConversationUnowned', () => {
  it('allows a resume of a conversation no record holds', () => {
    const other = recordHolding({
      provider: 'claude',
      sessionId: 'another-session',
      leafUuid: null
    })
    expect(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        hostHolding([other])
      )
    ).not.toThrow()
  })

  it('allows a resume whose only holder is proven exited', () => {
    expect(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        hostHolding([recordHolding(CLAUDE_CONVERSATION, EXITED)])
      )
    ).not.toThrow()
  })

  it('refuses a resume of a conversation a live chat holds', () => {
    const error = refusalFrom(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        hostHolding([recordHolding(CLAUDE_CONVERSATION, LIVE)])
      )
    )
    expect(error.refusal.code).toBe('agent_session_conflict')
    expect(error.refusal.details).toEqual({ reason: 'conversationHeldElsewhere' })
  })

  it('refuses a resume of a conversation a chat holds with an unverifiable owner', () => {
    const error = refusalFrom(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        hostHolding([recordHolding(CLAUDE_CONVERSATION, UNVERIFIABLE)])
      )
    )
    expect(error.refusal.details).toEqual({ reason: 'conversationHeldElsewhere' })
  })

  it('allows when this process has no structured host', () => {
    expect(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        null
      )
    ).not.toThrow()
  })

  it('leaves the automatic branch alone', () => {
    expect(() =>
      assertExplicitResumeConversationUnowned(
        { kind: 'automatic', sleepingCheckpointId: 'checkpoint_123456789012345678901' },
        hostHolding([recordHolding(CLAUDE_CONVERSATION, LIVE)])
      )
    ).not.toThrow()
  })

  it('does not match a conversation held under a different provider', () => {
    expect(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('codex', 'provider-session-alpha-1'),
        hostHolding([recordHolding(CLAUDE_CONVERSATION, LIVE)])
      )
    ).not.toThrow()
  })

  it('allows when the only chain naming the conversation has forked away from it', () => {
    const forked = recordForkedFrom(CLAUDE_CONVERSATION, {
      provider: 'claude',
      sessionId: 'provider-session-beta-2',
      leafUuid: null
    })
    expect(() =>
      assertExplicitResumeConversationUnowned(
        explicitResume('claude', 'provider-session-alpha-1'),
        hostHolding([forked])
      )
    ).not.toThrow()
  })
})

describe('terminal.ensureAgentSession hold wiring', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  function runtimeStub() {
    return {
      getRuntimeId: () => 'runtime-1',
      ensureAgentSession: vi.fn().mockResolvedValue({
        terminal: { handle: 'term_1', worktreeId: 'worktree-1', title: null },
        disposition: 'created'
      }),
      createAgentSession: vi.fn()
    }
  }

  function dispatcherFor(runtime: ReturnType<typeof runtimeStub>): RpcDispatcher {
    return new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard under test reaches only the members `runtimeStub` provides; the dispatcher asks for none of the rest.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
  }

  function request(params: unknown): RpcRequest {
    return { id: 'request-1', authToken: 'token', method: 'terminal.ensureAgentSession', params }
  }

  function installHost(records: AgentSessionRecord[]): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only reads deps.store.listRecords, the single member this stub provides.
    setStructuredAgentSessionHost(hostHolding(records) as unknown as StructuredAgentSessionHost)
  }

  it('refuses before the runtime when a structured chat holds the conversation', async () => {
    installHost([recordHolding(CLAUDE_CONVERSATION, LIVE)])
    const runtime = runtimeStub()
    const response = await dispatcherFor(runtime).dispatch(
      request(explicitResume('claude', 'provider-session-alpha-1'))
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent_session_conflict',
        data: { refusal: { details: { reason: 'conversationHeldElsewhere' } } }
      }
    })
    expect(runtime.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('passes a resume of an unheld conversation to the runtime', async () => {
    installHost([
      recordHolding({ provider: 'claude', sessionId: 'another-session', leafUuid: null }, LIVE)
    ])
    const runtime = runtimeStub()
    const response = await dispatcherFor(runtime).dispatch(
      request(explicitResume('claude', 'provider-session-alpha-1'))
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.ensureAgentSession).toHaveBeenCalledTimes(1)
  })
})

describe('provider conversation gate', () => {
  it('serializes opposite-lane work for one conversation and releases after failure', async () => {
    let unblock!: () => void
    const started = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const order: string[] = []
    const first = withAgentSessionConversationGate('claude:conversation-1', async () => {
      order.push('terminal-start')
      await started
      order.push('terminal-end')
      throw new Error('spawn failed')
    })
    const second = withAgentSessionConversationGate('claude:conversation-1', async () => {
      order.push('structured')
      return 'admitted'
    })

    await Promise.resolve()
    expect(order).toEqual(['terminal-start'])
    unblock()
    await expect(first).rejects.toThrow('spawn failed')
    await expect(second).resolves.toBe('admitted')
    expect(order).toEqual(['terminal-start', 'terminal-end', 'structured'])
  })

  it('does not serialize independent conversations', async () => {
    const order: string[] = []
    const first = withAgentSessionConversationGate('claude:conversation-a', async () => {
      order.push('a')
    })
    const second = withAgentSessionConversationGate('claude:conversation-b', async () => {
      order.push('b')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['a', 'b'])
  })
})
