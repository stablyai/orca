import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { AGENT_SESSION_RPC_ERROR_CODES } from '../../../../shared/agent-session-host-authority'
import { AGENT_SESSION_OPERATION_FUTURE_SKEW_MS } from '../../../../shared/agent-session-host-authority'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { AGENT_SESSION_METHODS } from './agent-session'
import { TERMINAL_METHODS } from './terminal'

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

function terminalResult(disposition: 'created' | 'adopted' | 'replayed' = 'created') {
  return {
    terminal: {
      handle: 'term_1',
      worktreeId: 'worktree-1',
      title: null
    },
    disposition
  }
}

function runtimeStub() {
  return {
    getRuntimeId: () => 'runtime-1',
    ensureAgentSession: vi.fn().mockResolvedValue(terminalResult()),
    createAgentSession: vi.fn().mockResolvedValue(terminalResult())
  }
}

describe('agent session RPC methods', () => {
  it('dispatches an explicit structured resume without an authoritative command', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'omp',
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        ompResumeFilePath: '/custom/omp/project/session.jsonl',
        agentArgs: '--profile review',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        presentation: 'focused',
        placement: { tabId: 'tab-1', leafId: 'leaf-1' }
      })
    )

    expect(response).toMatchObject({ ok: true, result: { disposition: 'created' } })
    expect(runtime.ensureAgentSession).toHaveBeenCalledWith(
      {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'omp',
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        ompResumeFilePath: '/custom/omp/project/session.jsonl',
        agentArgs: '--profile review',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        presentation: 'focused',
        placement: { tabId: 'tab-1', leafId: 'leaf-1' }
      },
      {}
    )
  })

  it('keeps automatic authority checkpoint-only', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        kind: 'automatic',
        sleepingCheckpointId: 'checkpoint_123456789012345678901',
        worktree: 'id:forged',
        placement: { tabId: 'forged' }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects mismatched agent/provider identity before runtime mutation', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'antigravity',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('rejects opaque fresh-launch authority and malformed operation IDs', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const opaque = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'codex',
        command: 'codex resume provider-session-1'
      })
    )
    const malformed = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: 'not-time-sortable',
        worktree: 'id:worktree-1',
        agent: 'codex'
      })
    )

    expect(opaque).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('preserves legacy agent-bearing terminal.create requests for mixed-version clients', async () => {
    const createTerminal = vi.fn().mockResolvedValue({ handle: 'term-1' })
    const dedupeTerminalCreate = vi.fn(
      async (
        _clientIdentity: string,
        worktree: string | undefined,
        _clientMutationId: string | undefined,
        _reconcileExisting: boolean,
        run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
      ) => run(worktree, undefined)
    )
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      createTerminal,
      dedupeTerminalCreate
    }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: TERMINAL_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.create', {
        worktree: 'id:worktree-1',
        command: 'codex resume provider-session-1',
        launchAgent: 'codex'
      })
    )

    expect(response.ok).toBe(true)
    expect(dedupeTerminalCreate).toHaveBeenCalledWith(
      'local',
      'id:worktree-1',
      undefined,
      false,
      expect.any(Function)
    )
    expect(createTerminal).toHaveBeenCalledWith('id:worktree-1', {
      command: 'codex resume provider-session-1',
      startupCommandDelivery: undefined,
      env: undefined,
      launchAgent: 'codex',
      title: undefined,
      focus: false,
      rendererBacked: false,
      activate: false,
      presentation: undefined,
      tabId: undefined,
      leafId: undefined
    })
  })

  it('rejects future-dated operation IDs before runtime mutation', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    const now = 1_752_883_200_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)

    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: `${now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1}-0123456789abcdef0123456789abcdef`,
        worktree: 'id:worktree-1',
        agent: 'codex'
      })
    )
    dateNow.mockRestore()

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_invalid' }
    })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('passes authenticated caller identity outside the request payload', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    const replies: RpcResponse[] = []

    await dispatcher.dispatchStreaming(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'codex',
        prompt: 'Fix the race',
        promptDelivery: 'draft',
        agentArgs: '--profile review',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        viewMode: 'chat'
      }),
      (response) => replies.push(JSON.parse(response) as RpcResponse),
      { clientId: 'authenticated-device', clientKind: 'runtime' }
    )

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ ok: true, result: { disposition: 'created' } })
    expect(runtime.createAgentSession).toHaveBeenCalledWith(
      {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'codex',
        prompt: 'Fix the race',
        promptDelivery: 'draft',
        agentArgs: '--profile review',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        viewMode: 'chat'
      },
      { clientId: 'authenticated-device', clientKind: 'runtime' }
    )
  })

  it('rejects draft delivery without a non-empty prompt', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'claude',
        prompt: '   ',
        promptDelivery: 'draft'
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('rejects oversized structured agent arguments before runtime mutation', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'codex',
        agentArgs: 'a'.repeat(16 * 1024 + 1)
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it.each(AGENT_SESSION_RPC_ERROR_CODES)('preserves stable runtime error %s', async (code) => {
    const runtime = runtimeStub()
    runtime.ensureAgentSession.mockRejectedValueOnce(new Error(code))
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        kind: 'automatic',
        sleepingCheckpointId: 'checkpoint_123456789012345678901'
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code } })
  })

  it('advertises the capability without moving the mixed-version protocol fence', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
    expect(MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION).toBe(2)
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY)
  })
})
