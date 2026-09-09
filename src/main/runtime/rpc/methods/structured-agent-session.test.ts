// The wire boundary: who may see `agentSession.*` at all, and what shapes it
// accepts once they can. The dispatcher harness lives in the shared fixture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { ALL_RPC_METHODS } from './index'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { CLEANUP_METHODS } from './structured-agent-session-gate-classification.test-fixture'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  sendParams,
  STATUS_SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.reveal', () => {
  it.each(['codex', 'claude'] as const)('republishes a persisted %s chat tab', async (agent) => {
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent,
      readable: true
    })

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(hostCalls.revealSession).toHaveBeenCalledWith(SESSION)
    expect(response).toMatchObject({ ok: true, result: { ok: true, agent } })
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ agent, activate: true })
    )
  })

  it('publishes the workspace the host reported, not one the client could assert', async () => {
    // The client sends only a session id, so a stale or forged one cannot aim the publish at
    // another workspace.
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-from-record',
      agent: 'claude',
      readable: true
    })

    await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith({
      workspaceId: 'workspace-from-record',
      sessionId: SESSION,
      agent: 'claude',
      activate: true
    })
  })

  it('publishes the tab even when the journal could not be read', async () => {
    // A pre-SQLite chat restores to nothing, but attach still recovers it, so the tab is worth
    // publishing and the pane's hold finishes the job. Refusing here would strand it forever.
    hostCalls.revealSession.mockResolvedValueOnce({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent: 'codex',
      readable: false
    })

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: true, result: { ok: true, readable: false } })
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledOnce()
  })

  it('refuses rather than throws when the host holds no such record', async () => {
    hostCalls.revealSession.mockRejectedValueOnce(new Error('agent_session_identity_required'))

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_identity_required' } }
    })
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it('does not launder an unrelated fault into a refusal', async () => {
    hostCalls.revealSession.mockRejectedValueOnce(new Error('EACCES: journal directory'))

    const response = await call('agentSession.reveal', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: false })
  })

  it('is refused for a client that cannot read structured sessions', async () => {
    const response = await call(
      'agentSession.reveal',
      { sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(response).toMatchObject({ ok: false })
    expect(hostCalls.revealSession).not.toHaveBeenCalled()
  })
})

describe('capability gating', () => {
  it('clears durable tab visibility when closing through the agent-session RPC', async () => {
    const response = await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false)
    expect(hostCalls.setSessionTabVisibility.mock.invocationCallOrder[0]).toBeLessThan(
      hostCalls.close.mock.invocationCallOrder[0]!
    )
  })

  it('does not stop the provider when durable tab retirement fails', async () => {
    hostCalls.setSessionTabVisibility.mockRejectedValueOnce(new Error('visibility write failed'))

    const response = await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: false })
    expect(hostCalls.close).not.toHaveBeenCalled()
  })

  it('advertises the capability without bumping the protocol version', () => {
    expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY)
    // Additive methods do not break an old client; bumping would strand every
    // paired device that has not updated.
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
  })

  it('registers every structured method on the runtime manifest', () => {
    const names = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of STRUCTURED_AGENT_SESSION_METHODS) {
      expect(names).toContain(method.name)
    }
    // Bump deliberately: the whole agentSession.* surface is behind the structured capability,
    // so an additive method is invisible to old clients and needs no protocol bump.
    expect(STRUCTURED_AGENT_SESSION_METHODS).toHaveLength(22)
  })

  it('hides the surface from a declared client that did not advertise it', async () => {
    const response = await call('agentSession.send', sendParams(), {
      clientKind: 'runtime',
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
      { clientKind: 'runtime', clientCapabilities: [] }
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

  it('requires the host structured-chat setting for mobile clients', async () => {
    const response = await call('agentSession.send', sendParams(), STRUCTURED_MOBILE_CLIENT, {
      getClientSettings: () => ({ experimentalStructuredNativeChat: false })
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(hostCalls.send).not.toHaveBeenCalled()
  })

  it('serves mobile clients only after capability and setting negotiation', async () => {
    const response = await call('agentSession.send', sendParams(), STRUCTURED_MOBILE_CLIENT, {
      getClientSettings: () => ({ experimentalStructuredNativeChat: true })
    })
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.send).toHaveBeenCalledTimes(1)
  })

  it.each(CLEANUP_METHODS)(
    'keeps $method hidden from remote clients without the capability',
    async ({ method, params, hostCall }) => {
      const response = await call(method, params, {
        clientKind: 'runtime',
        clientCapabilities: []
      })

      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      expect(hostCalls[hostCall]).not.toHaveBeenCalled()
    }
  )

  it.each(CLEANUP_METHODS)(
    'does not install a host for cleanup-only method $method',
    async ({ method, params }) => {
      const ensureHost = vi.fn()
      setStructuredAgentSessionHost(null)

      const response = await call(method, params, STRUCTURED_CLIENT, {
        getClientSettings: () => ({ experimentalStructuredNativeChat: false }),
        ensureStructuredAgentSessionHost: ensureHost
      })

      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      expect(ensureHost).not.toHaveBeenCalled()
    }
  )

  it('serves an in-process caller, which negotiates no capabilities at all', async () => {
    const response = await call('agentSession.send', sendParams())
    expect(response).toMatchObject({ ok: true })
  })

  it('reports the surface as absent when no host is installed', async () => {
    setStructuredAgentSessionHost(null)
    const response = await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)
    expect(response).toMatchObject({ ok: false })
  })
})

describe('method routing', () => {
  it('creates from a client intent while the host resolves paths and provider identity', async () => {
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
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith({
      ...params,
      callerKey: 'trusted-local:runtime'
    })
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
        options: { model: 'gpt-5.6-sol', effort: 'medium' }
      })
    )
    expect(hostCalls.attach.mock.calls[0]?.[1]).not.toHaveProperty('providerHandle')
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, activate: true })
    )
  })

  it.each(['claude', 'codex'])(
    'forwards a %s history resume through create preparation',
    async (agent) => {
      const fields = {
        worktree: 'id:workspace-1',
        agent,
        resumeFrom: { providerSessionId: 'prior-session' }
      }
      const params = {
        envelope: envelope({
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: SESSION,
            fields
          })
        }),
        ...fields
      }
      expect(await call('agentSession.create', params, STRUCTURED_CLIENT)).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith({
        ...params,
        callerKey: 'trusted-local:runtime'
      })
    }
  )

  it('routes Claude create support and create through the provider-aware runtime', async () => {
    const worktree = 'id:workspace-1'
    const support = await call(
      'agentSession.createSupport',
      { worktree, agent: 'claude' },
      STRUCTURED_CLIENT
    )
    expect(support).toMatchObject({ ok: true, result: { supported: true } })
    expect(runtimeCalls.getStructuredAgentSessionCreateSupport).toHaveBeenCalledWith(
      worktree,
      'claude'
    )

    const params = {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree, agent: 'claude' }
        })
      }),
      worktree,
      agent: 'claude'
    }
    const created = await call('agentSession.create', params, STRUCTURED_CLIENT)
    expect(created).toMatchObject({ ok: true, result: { ok: true } })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledWith({
      ...params,
      callerKey: 'trusted-local:runtime'
    })
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/host/.claude' }
      })
    )
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        activate: true,
        agent: 'claude'
      })
    )
  })

  it('reports an unknown create outcome when attach commits before tab publication fails', async () => {
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

    const response = await call('agentSession.create', params, STRUCTURED_CLIENT, {
      publishStructuredAgentSessionTab: vi.fn(async () => {
        throw new Error('publish failed')
      })
    })

    expect(hostCalls.attach).toHaveBeenCalledOnce()
    expect(response).toMatchObject({
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'agent_session_operation_unknown' }
      }
    })
  })

  it('separates create from ensure by the fence the client may declare', async () => {
    const created = await call('agentSession.create', attachParams())
    expect(created).toMatchObject({ ok: true })

    const fenced = await call('agentSession.create', attachParams({ envelope: envelope() }))
    expect(fenced).toMatchObject({ ok: false })

    const ensured = await call('agentSession.ensure', attachParams({ envelope: envelope() }))
    expect(ensured).toMatchObject({ ok: true })
  })

  /** A client-supplied location skips the worktree-resolving support check, so both attach-shaped
   *  entries must ask the executing host directly or a host that cannot fence a provider child
   *  would create one anyway. */
  it('returns a refusal envelope when create cannot support a client-supplied location', async () => {
    hostCalls.supportsCreate.mockReturnValue(false)

    const refused = await call('agentSession.create', attachParams())

    expect(refused).toMatchObject({
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported' }
      }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(hostCalls.supportsCreate).toHaveBeenCalledWith(attachParams().location, 'codex')
  })

  it('keeps ensure failures as top-level errors for an unsupported client location', async () => {
    hostCalls.supportsCreate.mockReturnValue(false)

    const refused = await call('agentSession.ensure', attachParams())

    expect(refused).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(hostCalls.supportsCreate).toHaveBeenCalledWith(attachParams().location, 'codex')
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

  it('routes an optional background task id through cancellation', async () => {
    const params = {
      envelope: envelope(),
      turnId: 'background-tasks',
      scope: 'background-tasks' as const,
      taskId: 'task-2'
    }

    const response = await call('agentSession.cancel', params, STRUCTURED_CLIENT)

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.cancel).toHaveBeenCalledWith(expect.anything(), params)
  })

  it('routes the structured handoff mutation through the host', async () => {
    const response = await call('agentSession.requestHandoff', {
      envelope: envelope(),
      direction: 'to-tui',
      mode: 'now',
      action: 'start'
    })

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.requestHandoff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ direction: 'to-tui', mode: 'now', action: 'start' })
    )
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

  it('rejects invalid or unscoped background task ids', async () => {
    await rejects('agentSession.cancel', {
      envelope: envelope(),
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: ' task-2'
    })
    await rejects('agentSession.cancel', {
      envelope: envelope(),
      turnId: 'turn-1',
      taskId: 'task-2'
    })
    expect(hostCalls.cancel).not.toHaveBeenCalled()
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

  it('accepts the maximum fully encoded Claude choice group and retains a finite bound', async () => {
    const maximumSelections = Array.from({ length: 4 }, (_, questionIndex) => ({
      questionId: `q${questionIndex + 1}`,
      optionIds: Array.from(
        { length: 4 },
        (_, optionIndex) => `q${questionIndex + 1}:choice-${optionIndex + 1}`
      )
    }))
    const optionId = `question-group:${encodeURIComponent(JSON.stringify(maximumSelections))}`
    expect(optionId.length).toBe(610)

    const response = await call(
      'agentSession.respondToQuestion',
      {
        envelope: envelope(),
        itemId: 'item-1',
        expectedRevision: 1,
        optionId
      },
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.respondToPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ optionId })
    )

    await rejects('agentSession.respondToQuestion', {
      envelope: envelope(),
      itemId: 'item-1',
      expectedRevision: 1,
      optionId: 'x'.repeat(1025)
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

describe('agentSession.subscribeStatus', () => {
  it('is invisible to a client without the structured capability', async () => {
    const reply = await call('agentSession.subscribeStatus', null, { clientKind: 'runtime' })
    expect(reply.ok).toBe(false)
    expect(hostCalls.subscribeStatus).not.toHaveBeenCalled()
  })

  it('opens the host status feed with a projected snapshot as its first reply', async () => {
    const reply = await call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT)
    expect(reply).toMatchObject({
      ok: true,
      result: {
        type: 'snapshot',
        sessions: [
          {
            sessionId: STATUS_SESSION,
            workspaceId: 'workspace-1',
            agent: 'codex',
            status: 'working',
            latestPrompt: 'write a poem',
            updatedAt: 2
          }
        ]
      }
    })
    expect(hostCalls.subscribeStatus).toHaveBeenCalledOnce()
  })
})

describe('rewind wire boundary', () => {
  it('routes the exact item and epoch through the structured capability gate', async () => {
    const params = { envelope: envelope(), itemId: 'chosen', expectedEpoch: 'current' }
    const result = await call('agentSession.rewind', params, STRUCTURED_CLIENT)
    expect(result).toMatchObject({ result: { ok: true } })
    expect(hostCalls.rewind).toHaveBeenCalledWith(expect.anything(), params)
  })
  it('rejects absent epoch and caller-supplied provider keys', async () => {
    for (const params of [
      { envelope: envelope(), itemId: 'chosen' },
      { envelope: envelope(), itemId: 'chosen', expectedEpoch: 'current', beforeTurnId: 'forged' }
    ]) {
      expect(await call('agentSession.rewind', params, STRUCTURED_CLIENT)).toHaveProperty('error')
    }
    expect(hostCalls.rewind).not.toHaveBeenCalled()
  })
})
