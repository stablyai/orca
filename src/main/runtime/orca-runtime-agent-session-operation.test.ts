import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../shared/rpc-contract/agent-session-params'
import { describe, expect, it, vi } from 'vitest'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'
import { buildAgentStartupPlan, buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { IPtyProvider } from '../providers/pty-provider-contract'

function operationId(now = Date.now(), nonce = '0123456789abcdef0123456789abcdef'): string {
  return `${now}-${nonce}`
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
  provider?: Pick<
    IPtyProvider,
    'supportsAgentSessionClaims' | 'supportsAgentSessionCreateOperations'
  >,
  settings: Record<string, unknown> = {}
) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this operation fixture supplies only getSettings; terminal scope and PTY dependencies are installed below.
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        ...settings
      })
    } as never,
    undefined,
    provider ? { getLocalProvider: () => provider as never } : undefined
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  return runtime
}

// #17929: lost SSH spawn responses must remain reclaimable.
function installRemoteReclaimHarness(
  runtime: OrcaRuntimeService,
  listProcesses: ReturnType<typeof vi.fn>
): void {
  const handleByPtyId = new Map<string, string>()
  Object.assign(runtime, {
    ptyController: { listProcesses },
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })),
    executionOwnerSupportsAgentSessionOperation: vi.fn(async () => true),
    adoptControllerTerminalHandle: vi.fn((ptyId: string, handle: string) => {
      handleByPtyId.set(ptyId, handle)
    }),
    recordPtyWorktree: vi.fn((ptyId: string, worktreeId: string, state: { title?: string }) => ({
      ptyId,
      worktreeId,
      title: state.title ?? null
    })),
    issuePtyHandle: vi.fn((pty: { ptyId: string }) => handleByPtyId.get(pty.ptyId))
  })
}

async function fenceRemoteAgentSessionSpawn(runtime: OrcaRuntimeService) {
  const failure = Object.assign(new Error('execution_owner_unavailable'), {
    agentSessionOperationOutcome: 'unknown' as const
  })
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
  return { createTerminal, failure, id }
}

describe('agent-session execution namespace', () => {
  it('calls the selected provider probe with its receiver and caller signal', async () => {
    const signal = new AbortController().signal
    const provider: Pick<IPtyProvider, 'supportsAgentSessionClaims'> = {
      async supportsAgentSessionClaims(options) {
        expect(this).toBe(provider)
        expect(options?.signal).toBe(signal)
        return true
      }
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    await runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      },
      { signal }
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({ signal })
    )
  })

  it.each(['claude', 'codex'] as const)(
    'ensures existing %s with raw fallback and genuine picks, excluding fresh map',
    async (agent) => {
      const runtime = createRuntime(undefined, {
        agentPermissionDefault: 'own',
        agentLaunchChoices: { [agent]: { model: 'fresh-only', options: { effort: 'high' } } },
        agentDefaultArgs: { [agent]: '--model literal' },
        agentDefaultEnv: { [agent]: { KEEP: 'yes' } }
      })
      const create = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
      for (const launchPreferences of [undefined, { model: 'picked', effort: 'low' }]) {
        await runtime.ensureAgentSession({
          kind: 'explicit',
          worktree: 'id:worktree-1',
          agent,
          providerSession: { key: 'session_id', id: 'continuing' },
          ...(launchPreferences ? { launchPreferences } : {})
        })
        const applied = create.mock.calls.at(-1)?.[1]
        expect(applied?.command).toContain('continuing')
        expect(applied?.command).toContain(launchPreferences ? 'picked' : 'literal')
        expect(applied?.command).not.toContain('fresh-only')
        expect(applied?.command).not.toContain('high')
        expect(applied?.env).toMatchObject({ KEEP: 'yes' })
      }
    }
  )

  it('retains compiled policy through args-only host reconstruction and repeated recorded resume', async () => {
    const launch = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '-m old-model -c model_reasoning_effort=low -c model_verbosity=low',
      sessionOptions: { model: 'gpt-5.5', effort: 'high', permissionMode: 'ask' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(launch?.sessionOptions).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
      permissionMode: 'ask'
    })
    expect(launch?.launchCommand).not.toContain('old-model')
    const policyTokens = [
      'codex',
      '-c',
      'model_verbosity=low',
      '-a',
      'on-request',
      '-s',
      'read-only',
      '-c',
      'approvals_reviewer=user'
    ]
    expect(tokenizeStartupCommand(launch?.launchConfig.agentCommand ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: policyTokens
    })
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const providerSession = { key: 'session_id' as const, id: 'provider-session-1' }
    await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'codex',
      providerSession,
      agentArgs: launch?.launchConfig.agentArgs
    })
    const host = createTerminal.mock.calls[0]?.[1]
    expect(tokenizeStartupCommand(host?.command ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: [
        policyTokens[0],
        '-c',
        'disable_paste_burst=true',
        ...policyTokens.slice(1),
        'resume',
        providerSession.id
      ]
    })
    expect(host?.launchConfig).toEqual(launch?.launchConfig)
    const resumeInputs = {
      agent: 'codex' as const,
      providerSession,
      platform: 'linux' as const,
      cmdOverrides: {}
    }
    const resumed = buildAgentResumeStartupPlan({ ...resumeInputs, ...host?.launchConfig })
    const resumedAgain = buildAgentResumeStartupPlan({ ...resumeInputs, ...resumed?.launchConfig })
    expect(resumedAgain?.launchConfig).toEqual(launch?.launchConfig)
    expect(tokenizeStartupCommand(resumedAgain?.launchCommand ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: [...policyTokens, '-c', 'disable_paste_burst=true', 'resume', providerSession.id]
    })
  })

  it('propagates probe getter failure before entering the probe failure fallback', async () => {
    const failure = new Error('probe getter failed')
    const runtime = createRuntime({
      get supportsAgentSessionClaims(): IPtyProvider['supportsAgentSessionClaims'] {
        throw failure
      }
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toBe(failure)
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('captures the terminal callee before reading launch option getters', async () => {
    const runtime = createRuntime()
    const replacement = vi.fn(async () => terminal())
    const original = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const resume = {
      kind: 'explicit' as const,
      worktree: 'id:worktree-1',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'provider-session-1' },
      get terminalKittyKeyboardProtocol() {
        runtime.createTerminal = replacement
        return true
      }
    }
    await runtime.ensureAgentSession(resume)
    expect(original).toHaveBeenCalledOnce()
    expect(original.mock.calls[0]).toHaveLength(2)
    expect(replacement).not.toHaveBeenCalled()
    await runtime.ensureAgentSession(resume)
    expect(replacement).toHaveBeenCalledOnce()
    expect(replacement.mock.calls[0]).toHaveLength(2)
  })
})

describe('agent-session create operation ledger', () => {
  it.each(['auto-submit', 'draft', undefined] as const)(
    'suppresses startup updates only for auto-submitted launches: %s',
    async (promptDelivery) => {
      const runtime = createRuntime()
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
      await runtime.createAgentSession(
        request(operationId(), { prompt: undefined, promptDelivery })
      )
      expect(createTerminal).toHaveBeenCalledWith(
        'id:worktree-1',
        expect.objectContaining({ suppressStartupUpdatePrompt: promptDelivery === 'auto-submit' })
      )
    }
  )

  it.each([true, false, undefined])(
    'forwards renderer keyboard support on create and resume: %s',
    async (terminalKittyKeyboardProtocol) => {
      const runtime = createRuntime()
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
      await runtime.createAgentSession(
        CreateAgentSessionParams.parse(request(operationId(), { terminalKittyKeyboardProtocol }))
      )
      await runtime.ensureAgentSession(
        EnsureAgentSessionParams.parse({
          kind: 'explicit',
          worktree: 'id:worktree-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-session-1' },
          terminalKittyKeyboardProtocol
        })
      )
      expect(createTerminal).toHaveBeenCalledTimes(2)
      for (const call of createTerminal.mock.calls) {
        expect(call[1]?.terminalKittyKeyboardProtocol).toBe(terminalKittyKeyboardProtocol)
      }
    }
  )
  it('refuses a changed keyboard capability under the same create operation', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()
    await runtime.createAgentSession(request(id, { terminalKittyKeyboardProtocol: true }))
    await expect(runtime.createAgentSession(request(id))).rejects.toThrow(
      'agent_session_operation_conflict'
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('selects legacy before spawn or ledger state for an old daemon', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => false),
      supportsAgentSessionCreateOperations: vi.fn(() => false)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
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

  it('shapes the launch for the route it resolved, not a repo row on another host', async () => {
    // #11163: scope.repo is display metadata, possibly from another host; never derive launch routing from it.
    const runtime = createRuntime({
      supportsAgentSessionClaims: () => true,
      supportsAgentSessionCreateOperations: () => true
    })
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/repo/worktree-1',
      connectionId: null,
      repo: {
        id: 'repo-1',
        connectionId: 'openclaw',
        executionHostId: null,
        path: '/srv/openclaw'
      },
      folderWorkspace: null
    })
    let planned: TerminalCreateOptions | undefined
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async (selector = '', opts = {}) => {
      const scope = await runtime.resolveTerminalWorkspaceLaunchScope(selector)
      planned = await runtime.resolveAgentTerminalCreateOptions(scope, opts)
      return terminal()
    })

    await runtime.createAgentSession(
      request(operationId(), { agent: 'claude-agent-teams', prompt: '' })
    )

    expect(planned?.command).toContain(
      process.platform === 'linux' ? 'orca-ide claude-teams' : 'orca claude-teams'
    )
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

  it('waits for Codex shell launch preparation before a structured resume', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-session-1' }
    })

    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({
        command: expect.stringContaining("'resume' 'provider-session-1'"),
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it('selects nested SSH legacy fallback before reading a Pi transcript path locally', async () => {
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
        agent: 'pi',
        providerSession: {
          key: 'session_id',
          id: 'provider-session-1',
          transcriptPath: '/remote-only/pi/session.jsonl'
        }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
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

  it('joins reordered complete options and gives their resolved execution the same identity', async () => {
    const runtime = createRuntime()
    Object.assign(runtime, { runtimeId: 'complete-options-host' })
    let finish!: (result: ReturnType<typeof terminal>) => void
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const id = operationId()
    const inputs = {
      sessionOptions: { model: 'opus', fastMode: 'false' },
      extraAgentArgs: '--add-dir docs'
    }
    const first = runtime.createAgentSession(request(id, inputs), { clientId: 'device-a' })
    const reordered = { ...inputs, sessionOptions: { fastMode: 'false', model: 'opus' } }
    const joined = runtime.createAgentSession(request(id, reordered), { clientId: 'device-a' })
    await vi.waitFor(() => expect(createTerminal).toHaveBeenCalledOnce())
    finish(terminal())
    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(joined).resolves.toMatchObject({ disposition: 'replayed' })

    const sameHost = createRuntime()
    Object.assign(sameHost, { runtimeId: 'complete-options-host' })
    const secondCreate = vi.spyOn(sameHost, 'createTerminal').mockResolvedValue(terminal())
    await sameHost.createAgentSession(request(id, reordered), { clientId: 'device-a' })
    expect(secondCreate.mock.calls[0]?.[1]?.agentSessionCreateOperationId).toBe(
      createTerminal.mock.calls[0]?.[1]?.agentSessionCreateOperationId
    )
    const resolvedIds = new Set([secondCreate.mock.calls[0]?.[1]?.agentSessionCreateOperationId])
    const changedRequests: Partial<RuntimeCreateAgentSessionRequest>[] = [
      { ...inputs, sessionOptions: { model: 'opus', fastMode: 'true' } },
      { ...inputs, extraAgentArgs: '--add-dir src' },
      { extraAgentArgs: inputs.extraAgentArgs },
      { extraAgentArgs: inputs.extraAgentArgs, sessionOptions: {} }
    ]
    for (const changed of changedRequests) {
      const changedHost = createRuntime()
      Object.assign(changedHost, { runtimeId: 'complete-options-host' })
      const changedCreate = vi.spyOn(changedHost, 'createTerminal').mockResolvedValue(terminal())
      await changedHost.createAgentSession(request(id, changed), { clientId: 'device-a' })
      resolvedIds.add(changedCreate.mock.calls[0]?.[1]?.agentSessionCreateOperationId)
    }
    expect(resolvedIds.size).toBe(5)
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('fences changed options, supplemental extras, and absent versus empty inputs', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()
    const inputs = { sessionOptions: { fastMode: 'false' }, extraAgentArgs: '--add-dir docs' }
    await runtime.createAgentSession(request(id, inputs))
    for (const changed of [
      { ...inputs, sessionOptions: { fastMode: 'true' } },
      { ...inputs, extraAgentArgs: '--add-dir src' }
    ]) {
      await expect(runtime.createAgentSession(request(id, changed))).rejects.toThrow(
        'agent_session_operation_conflict'
      )
    }
    const absentId = operationId(undefined, 'fedcba9876543210fedcba9876543210')
    await runtime.createAgentSession(request(absentId))
    for (const changed of [{ sessionOptions: {} }, { extraAgentArgs: '' }, { agentArgs: null }]) {
      await expect(runtime.createAgentSession(request(absentId, changed))).rejects.toThrow(
        'agent_session_operation_conflict'
      )
    }
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('compiles complete choices with host defaults, replacement Args and supplemental extras once', async () => {
    const runtime = createRuntime(undefined, {
      agentCmdOverrides: { claude: 'host-claude' },
      agentDefaultArgs: { claude: '--verbose' },
      agentDefaultEnv: { claude: { HOST_ENV: 'kept' } },
      agentPermissionDefault: 'accept-edits',
      agentLaunchChoices: { claude: { model: 'sonnet', options: { fastMode: 'false' } } }
    })
    const planned: TerminalCreateOptions[] = []
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (selector = '', opts = {}) => {
        const scope = await runtime.resolveTerminalWorkspaceLaunchScope(selector)
        planned.push(
          await runtime.resolveAgentTerminalCreateOptions(scope, opts, opts.sessionOptions)
        )
        return terminal()
      })
    for (const [index, overrides] of [
      {},
      { agentArgs: null },
      { agentArgs: '--debug' }
    ].entries()) {
      await runtime.createAgentSession(
        CreateAgentSessionParams.parse(
          request(operationId(undefined, String(index).padStart(32, '0')), {
            agent: 'claude',
            prompt: 'scheduled task',
            promptDelivery: 'auto-submit',
            sessionOptions: {
              model: 'opus',
              fastMode: 'true',
              ...(index > 0 ? { permissionMode: 'accept-edits' } : {})
            },
            launchPreferences: { model: 'legacy-model', effort: 'low' },
            extraAgentArgs: '--add-dir docs',
            ...overrides
          })
        )
      )
      const launch = planned[index]
      const parsed = tokenizeStartupCommand(launch?.command ?? '', 'posix')
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) {
        throw new Error('Expected a tokenizable host launch')
      }
      expect(parsed.tokens[0]).toBe('host-claude')
      expect(parsed.tokens).toEqual(
        expect.arrayContaining([
          '--model',
          'opus',
          '--settings',
          '{"fastMode":true}',
          '--permission-mode',
          'acceptEdits',
          '--add-dir',
          'docs',
          'scheduled task'
        ])
      )
      expect(parsed.tokens.filter((token) => token === '--add-dir')).toHaveLength(1)
      expect(parsed.tokens.filter((token) => token === 'scheduled task')).toHaveLength(1)
      expect(parsed.tokens.includes('--verbose')).toBe(index === 0)
      expect(parsed.tokens.includes('--debug')).toBe(index === 2)
      expect(parsed.tokens).not.toContain('sonnet')
      expect(parsed.tokens).not.toContain('legacy-model')
      expect(launch?.env).toMatchObject({ HOST_ENV: 'kept' })
      expect(launch?.launchAgent).toBe('claude')
      expect(launch?.launchConfig?.agentCommand).toContain('host-claude')
    }
    expect(createTerminal).toHaveBeenCalledTimes(3)
  })

  it('isolates operation ids by authenticated caller', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await runtime.createAgentSession(request(id), { clientId: 'device-a' })
    await runtime.createAgentSession(request(id), { clientId: 'device-b' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('starts a create however many unexpired operations are held, and still replays the first', async () => {
    // Per-caller/global count caps rejected unrelated user creates.
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const now = Date.now()
    const ids = Array.from(
      { length: 4_097 },
      (_, index) => `${now}-${index.toString(16).padStart(32, '0')}`
    )
    const dispositions = new Set<string>()
    for (const id of ids) {
      const created = await runtime.createAgentSession(request(id), { clientId: 'device-a' })
      dispositions.add(created.disposition)
    }

    expect([...dispositions]).toEqual(['created'])
    await expect(
      runtime.createAgentSession(request(ids[0]!), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledTimes(4_097)
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

  it('reclaims a fenced remote spawn the host is still holding', async () => {
    const runtime = createRuntime()
    const listProcesses = vi.fn(async () => [] as never[])
    installRemoteReclaimHarness(runtime, listProcesses)
    const { createTerminal, id, failure } = await fenceRemoteAgentSessionSpawn(runtime)
    const orphanHandle = createTerminal.mock.calls[0]?.[1]?.preAllocatedHandle as string
    listProcesses.mockResolvedValue([
      {
        id: 'ssh-1:pty2:e:1',
        cwd: '/remote/worktree-1',
        title: 'codex',
        worktreeId: 'worktree-1',
        terminalHandle: orphanHandle
      }
    ] as never)

    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle: orphanHandle, ptyId: 'ssh-1:pty2:e:1', worktreeId: 'worktree-1' }
    })
    expect(listProcesses).toHaveBeenCalledWith('ssh:ssh-1')
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(failure.message).toBe('execution_owner_unavailable')
  })

  it('replays the fenced failure when host inventory proves the spawn is gone', async () => {
    const runtime = createRuntime()
    const listProcesses = vi.fn(async () => [] as never[])
    installRemoteReclaimHarness(runtime, listProcesses)
    const { createTerminal, id, failure } = await fenceRemoteAgentSessionSpawn(runtime)

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(listProcesses).toHaveBeenCalledWith('ssh:ssh-1')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('replays the fenced failure when the remote host cannot answer', async () => {
    const runtime = createRuntime()
    const listProcesses = vi.fn(async () => {
      throw new Error('relay offline')
    })
    installRemoteReclaimHarness(runtime, listProcesses)
    const { createTerminal, id, failure } = await fenceRemoteAgentSessionSpawn(runtime)

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('refuses to adopt a same-handle PTY that belongs to another workspace', async () => {
    const runtime = createRuntime()
    const listProcesses = vi.fn(async () => [] as never[])
    installRemoteReclaimHarness(runtime, listProcesses)
    const { createTerminal, id, failure } = await fenceRemoteAgentSessionSpawn(runtime)
    listProcesses.mockResolvedValue([
      {
        id: 'ssh-1:pty2:e:9',
        cwd: '/remote/worktree-2',
        title: 'codex',
        worktreeId: 'worktree-2',
        terminalHandle: createTerminal.mock.calls[0]?.[1]?.preAllocatedHandle
      }
    ] as never)

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
