import { describe, expect, it, vi } from 'vitest'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'
import type { CodexControlledSessionManager } from '../codex/codex-controlled-session-manager'
import { resolveControlledCodexLaunchAuthority } from '../codex/codex-controlled-launch-authority'

function operationId(now = Date.now()): string {
  return `${now}-0123456789abcdef0123456789abcdef`
}

function request(
  clientOperationId: string,
  overrides: Partial<RuntimeCreateAgentSessionRequest> = {}
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'codex',
    prompt: 'do the thing',
    presentation: 'background',
    ...overrides
  }
}

function terminal() {
  return {
    handle: 'term_operation',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-operation',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime(
  provider?: {
    supportsAgentSessionClaims?: () => boolean
    supportsAgentSessionCreateOperations?: () => boolean
  },
  controlled?: {
    manager: Record<string, unknown>
    command?: string
    prepareCodexHome?: (workspacePath: string) => string | null
    resolveAccountId?: () => string | null
  }
) {
  if (controlled) {
    controlled.manager.prepareNewLaunch ??= vi.fn((input, command) => ({ input, command }))
    controlled.manager.launchPreparedNew ??= vi.fn((prepared) =>
      (controlled.manager.launchNew as (input: unknown) => unknown)(prepared.input)
    )
  }
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    {
      ...(provider ? { getLocalProvider: () => provider as never } : {}),
      ...(controlled
        ? {
            codexControlledSessionManager:
              controlled.manager as unknown as CodexControlledSessionManager,
            resolveControlledCodexLaunchAuthority: (workspacePath: string) =>
              resolveControlledCodexLaunchAuthority({
                workspacePath,
                commandOverride: controlled.command ?? '/trusted/bin/codex',
                prepareCodexHome: controlled.prepareCodexHome ?? (() => '/trusted/codex-home'),
                getSystemCodexHome: () => '/system/codex-home',
                resolveAccountId: controlled.resolveAccountId ?? (() => 'trusted-account')
              })
          }
        : {})
    }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return runtime
}

describe('agent-session create operation ledger', () => {
  it('routes explicit controlled coordinator creation through host-resolved authority', async () => {
    const controlledTerminal = terminal()
    const manager = {
      id: 'codex-controlled',
      launchNew: vi.fn().mockResolvedValue({
        disposition: 'created',
        surface: 'visible',
        identity: {
          conversationId: 'controlled-conversation',
          threadId: 'thread-1',
          terminalHandle: controlledTerminal.handle,
          terminalPtyId: controlledTerminal.ptyId,
          terminalTabId: controlledTerminal.tabId,
          terminalPaneKey: controlledTerminal.paneKey,
          worktreeId: controlledTerminal.worktreeId
        }
      }),
      getState: vi.fn(),
      prepareAndFinalizeTurn: vi.fn(),
      onTurnTerminal: vi.fn(() => () => {}),
      getConversationForPane: vi.fn((paneKey: string) =>
        paneKey === controlledTerminal.paneKey ? 'controlled-conversation' : null
      ),
      dispose: vi.fn()
    }
    const runtime = createRuntime(undefined, { manager })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const bind = vi
      .spyOn(runtime, 'bindOrchestrationConversationWake')
      .mockResolvedValue({} as never)

    await expect(
      runtime.createAgentSession(request(operationId(), { controlledCoordinator: true }))
    ).resolves.toMatchObject({
      terminal: { ...terminal(), surface: 'visible', title: 'Codex' },
      disposition: 'created'
    })

    expect(createTerminal).not.toHaveBeenCalled()
    expect(manager.launchNew).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: 'id:worktree-1',
        cwd: '/tmp/worktree-1',
        codexHome: '/trusted/codex-home',
        accountId: 'trusted-account',
        command: '/trusted/bin/codex',
        presentation: 'focused'
      })
    )
    await runtime.bindControlledCodexCoordinator('run-1', 3, controlledTerminal.paneKey)
    expect(bind).toHaveBeenCalledWith({
      runId: 'run-1',
      consumerGeneration: 3,
      provider: 'codex-controlled',
      conversationId: 'controlled-conversation'
    })
  })

  it.each([
    { agentArgs: '--arbitrary' },
    { startupCwd: '/tmp/other' },
    { promptDelivery: 'draft' as const }
  ])(
    'rejects caller-controlled launch authority before controller effects: %j',
    async (override) => {
      const manager = {
        id: 'codex-controlled',
        launchNew: vi.fn(),
        onTurnTerminal: vi.fn(() => () => {})
      }
      const runtime = createRuntime(undefined, { manager })

      await expect(
        runtime.createAgentSession(
          request(operationId(), { controlledCoordinator: true, ...override })
        )
      ).rejects.toThrow('controlled_codex_coordinator_unsupported')
      expect(manager.launchNew).not.toHaveBeenCalled()
    }
  )

  it('rejects an invalid trusted override before trust or controller side effects', async () => {
    const projectTrust = vi.fn()
    const prepareCodexHome = vi.fn((workspacePath: string) => {
      projectTrust(workspacePath)
      return '/trusted/codex-home'
    })
    const resolveAccountId = vi.fn(() => 'trusted-account')
    const manager = {
      id: 'codex-controlled',
      launchNew: vi.fn(),
      onTurnTerminal: vi.fn(() => () => {})
    }
    const runtime = createRuntime(undefined, {
      manager,
      command: `/trusted/bin/codex --profile "unmatched`,
      prepareCodexHome,
      resolveAccountId
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const internal = runtime as unknown as {
      markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }

    await expect(
      runtime.createAgentSession(request(operationId(), { controlledCoordinator: true }))
    ).rejects.toThrow('controlled Codex command is invalid')

    expect(internal.markLocalWorkspaceTrustedForAgent).not.toHaveBeenCalled()
    expect(prepareCodexHome).not.toHaveBeenCalled()
    expect(projectTrust).not.toHaveBeenCalled()
    expect(resolveAccountId).not.toHaveBeenCalled()
    expect(manager.launchNew).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('fails explicit controlled coordinator intent closed on an SSH execution host', async () => {
    const manager = {
      id: 'codex-controlled',
      launchNew: vi.fn(),
      onTurnTerminal: vi.fn(() => () => {})
    }
    const runtime = createRuntime(undefined, { manager })
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1',
      folderWorkspace: null
    })

    await expect(
      runtime.createAgentSession(request(operationId(), { controlledCoordinator: true }))
    ).rejects.toThrow('controlled_codex_coordinator_unsupported')
    expect(manager.launchNew).not.toHaveBeenCalled()
  })

  it.each([
    'controlled Codex launch is disabled',
    'controlled Codex launch is unsupported on this platform'
  ])('does not fall back or relaunch after controlled admission fails: %s', async (message) => {
    const failure = new Error(message)
    const manager = {
      id: 'codex-controlled',
      launchNew: vi.fn().mockRejectedValue(failure),
      onTurnTerminal: vi.fn(() => () => {})
    }
    const runtime = createRuntime(undefined, { manager })
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const id = operationId()
    const controlledRequest = request(id, { controlledCoordinator: true })

    await expect(runtime.createAgentSession(controlledRequest)).rejects.toBe(failure)
    await expect(runtime.createAgentSession(controlledRequest)).rejects.toBe(failure)

    expect(manager.launchNew).toHaveBeenCalledOnce()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('selects legacy before trust, spawn, or ledger state for an old daemon', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => false),
      supportsAgentSessionCreateOperations: vi.fn(() => false)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const internal = runtime as unknown as {
      markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    const id = operationId()

    await expect(runtime.createAgentSession(request(id))).rejects.toThrow(
      'agent_session_legacy_required'
    )
    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markLocalWorkspaceTrustedForAgent).not.toHaveBeenCalled()

    provider.supportsAgentSessionCreateOperations.mockReturnValue(true)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'created'
    })
    provider.supportsAgentSessionCreateOperations.mockReturnValue(false)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('requests exact client legacy fallback before nested SSH side effects', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('selects nested SSH legacy fallback before reading a Pi transcript path locally', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
      markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'pi',
        providerSession: {
          key: 'session_id',
          id: 'provider-session-1',
          transcriptPath: '/remote-only/pi/session.jsonl'
        }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markRemoteWorkspaceTrustedForAgent).not.toHaveBeenCalled()
  })

  it('replays the same completed operation without spawning again', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('joins concurrent retries and conflicts on a changed fingerprint', async () => {
    const runtime = createRuntime()
    let finish!: (result: ReturnType<typeof terminal>) => void
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const id = operationId()
    const first = runtime.createAgentSession(request(id), { clientId: 'device-a' })
    const joined = runtime.createAgentSession(request(id), { clientId: 'device-a' })

    await expect(
      runtime.createAgentSession(request(id, { prompt: 'changed' }), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_conflict')
    await expect(
      runtime.createAgentSession(request(id, { agentArgs: '--profile changed' }), {
        clientId: 'device-a'
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    finish(terminal())
    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(joined).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('isolates operation ids by authenticated caller', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await runtime.createAgentSession(request(id), { clientId: 'device-a' })
    await runtime.createAgentSession(request(id), { clientId: 'device-b' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects an expired unseen operation before terminal creation', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const expired = operationId(Date.now() - 25 * 60 * 60 * 1_000)

    await expect(
      runtime.createAgentSession(request(expired), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_expired')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('releases a failed pre-spawn operation for a safe retry', async () => {
    const runtime = createRuntime()
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('pre-spawn failure'))
      .mockResolvedValueOnce(terminal())
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      'pre-spawn failure'
    )
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      tabId: createTerminal.mock.calls[1]?.[1]?.tabId,
      leafId: createTerminal.mock.calls[1]?.[1]?.leafId,
      preAllocatedHandle: createTerminal.mock.calls[1]?.[1]?.preAllocatedHandle,
      agentSessionCreateOperationId:
        createTerminal.mock.calls[1]?.[1]?.agentSessionCreateOperationId
    })
    expect(createTerminal.mock.calls[0]?.[1]?.agentSessionCreateOperationId).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    )
  })

  it.each([
    ['controller admission fails', 'agent_session_exited_during_start'],
    ['publication fails', 'post-spawn publication failure']
  ])('retains a replay fence when %s after physical spawn commit', async (_case, message) => {
    const runtime = createRuntime()
    const failure = new Error(message)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_worktree, opts) => {
        opts?.onPtySpawnCommitted?.()
        throw failure
      })
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('retains a replay fence when the provider reports an unknown spawn outcome', async () => {
    const runtime = createRuntime()
    const failure = Object.assign(new Error('cleanup could not prove exit'), {
      agentSessionOperationOutcome: 'unknown' as const
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockRejectedValue(failure)
    const id = operationId()

    const attempts: Promise<RuntimeCreateAgentSessionResult>[] = [
      runtime.createAgentSession(request(id), { clientId: 'device-a' }),
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ]
    await expect(Promise.all(attempts)).rejects.toThrow(failure.message)
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})
