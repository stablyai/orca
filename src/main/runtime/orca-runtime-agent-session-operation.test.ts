import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'
import {
  setManagedCliLauncherStatus,
  clearManagedCliLauncherStatus
} from '../ssh/ssh-relay-session'
import { ManagedCliLauncherUnavailableError } from '../../shared/managed-cli-context'
import { resolveManagedOrchestrationExecutable } from './orchestration/cli-command'

const electronMocks = vi.hoisted(() => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: true }
}))
vi.mock('electron', () => electronMocks)

beforeEach(() => {
  installFakeAppEnvironment({ isPackaged: () => true })
})

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

function createRuntime(provider?: {
  supportsAgentSessionClaims?: () => boolean
  supportsAgentSessionCreateOperations?: () => boolean
}) {
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
    provider ? { getLocalProvider: () => provider as never } : undefined
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

// Why: an SSH-backed workspace whose spawn response was lost — the leak in #17929.
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
    markWorkspaceTrustedForAgent: vi.fn(async () => {}),
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

describe('agent-session create operation ledger', () => {
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

  it('shapes the launch for the route it resolved, not a repo row on another host', async () => {
    // `scope.repo` is display metadata and can be a row from a different host than the worktree
    // names (#11163). Reading it made a locally-routed launch emit the SSH relay shim name.
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
      // The rival row names openclaw while the worktree resolved to no SSH route at all.
      repo: {
        id: 'repo-1',
        connectionId: 'openclaw',
        executionHostId: null,
        path: '/srv/openclaw'
      },
      folderWorkspace: null
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.createAgentSession(
      request(operationId(), { agent: 'claude-agent-teams', prompt: '' })
    )

    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({ command: expect.stringContaining('orca-ide claude-teams') })
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
    expect(listProcesses).toHaveBeenCalledWith('ssh-1')
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
    expect(listProcesses).toHaveBeenCalledWith('ssh-1')
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

describe('managed CLI launcher gating', () => {
  it('blocks a managed worker terminal on an SSH host with no installed launcher', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'resolveTerminalContext').mockReturnValue({
      worktreeId: 'worktree-1',
      connectionId: 'ssh-managed-cli-gate'
    })

    expect(() => runtime.assertTerminalManagedCliAvailable('term_worker')).toThrow(
      ManagedCliLauncherUnavailableError
    )
  })

  it('allows a managed worker terminal once the launcher is recorded as installed', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'resolveTerminalContext').mockReturnValue({
      worktreeId: 'worktree-1',
      connectionId: 'ssh-managed-cli-gate'
    })
    setManagedCliLauncherStatus('ssh-managed-cli-gate', {
      state: 'installed',
      launcherPath: '/home/user/.orca-relay/bin/orca'
    })

    try {
      expect(() => runtime.assertTerminalManagedCliAvailable('term_worker')).not.toThrow()
    } finally {
      clearManagedCliLauncherStatus('ssh-managed-cli-gate')
    }
  })

  it('never gates a local terminal with no SSH connection', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'resolveTerminalContext').mockReturnValue({
      worktreeId: 'worktree-1',
      connectionId: null
    })

    expect(() => runtime.assertTerminalManagedCliAvailable('term_local')).not.toThrow()
  })
})

function stubPty(
  runtime: OrcaRuntimeService,
  handle: string,
  ptyId: string,
  pty: { connectionId: string | null; isWsl: boolean | null; worktreeId: string }
): void {
  vi.spyOn(runtime, 'resolveLeafForHandle').mockImplementation((h) =>
    h === handle ? { ptyId } : null
  )
  ;(runtime as unknown as { ptysById: Map<string, unknown> }).ptysById.set(ptyId, pty)
}

describe('ManagedCliContext construction across hosts', () => {
  it('builds a native local workspace_key and executable for a git-worktree terminal', () => {
    const runtime = createRuntime()
    stubPty(runtime, 'term_native', 'pty-native', {
      connectionId: null,
      isWsl: false,
      worktreeId: 'repo::worktree-1'
    })

    const context = runtime.buildTerminalManagedCliContext('term_native')

    // Why: the exact executable for a native, non-WSL, packaged local host is
    // this same resolution cli-command.ts already ships (`orca` off-Linux,
    // `orca-ide` on native Linux packaging) — assert against it directly
    // rather than hardcoding a platform-specific literal in this test.
    expect(context.executable).toBe(
      resolveManagedOrchestrationExecutable({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::worktree-1',
        isPackaged: true
      })
    )
    expect(context).toMatchObject({
      executionHostId: 'local',
      workspaceKey: 'worktree:repo::worktree-1',
      terminalHandle: 'term_native'
    })
  })

  it('builds the orca-ide executable for a packaged WSL terminal', () => {
    const runtime = createRuntime()
    stubPty(runtime, 'term_wsl', 'pty-wsl', {
      connectionId: null,
      isWsl: true,
      worktreeId: 'repo::worktree-2'
    })

    const context = runtime.buildTerminalManagedCliContext('term_wsl')

    expect(context.executable).toBe('orca-ide')
    expect(context.executionHostId).toBe('local')
  })

  it('builds the orca-dev executable for an unpacked (dev) local build', () => {
    installFakeAppEnvironment({ isPackaged: () => false })
    try {
      const runtime = createRuntime()
      stubPty(runtime, 'term_dev', 'pty-dev', {
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::worktree-3'
      })

      const context = runtime.buildTerminalManagedCliContext('term_dev')

      expect(context.executable).toBe('orca-dev')
    } finally {
      installFakeAppEnvironment({ isPackaged: () => true })
    }
  })

  it('builds the exact installed launcherPath (never bare orca) for an SSH terminal', () => {
    const runtime = createRuntime()
    stubPty(runtime, 'term_ssh', 'pty-ssh', {
      connectionId: 'ssh-managed-cli-context',
      isWsl: null,
      worktreeId: 'repo::worktree-4'
    })
    setManagedCliLauncherStatus('ssh-managed-cli-context', {
      state: 'installed',
      launcherPath: '/home/user/.orca-relay/bin/orca'
    })

    try {
      const context = runtime.buildTerminalManagedCliContext('term_ssh')
      expect(context).toMatchObject({
        executable: '/home/user/.orca-relay/bin/orca',
        executionHostId: 'ssh:ssh-managed-cli-context',
        workspaceKey: 'worktree:repo::worktree-4'
      })
    } finally {
      clearManagedCliLauncherStatus('ssh-managed-cli-context')
    }
  })

  it('throws instead of building a bare-orca context when the SSH launcher never installed', () => {
    const runtime = createRuntime()
    stubPty(runtime, 'term_ssh_unavailable', 'pty-ssh-unavailable', {
      connectionId: 'ssh-managed-cli-missing',
      isWsl: null,
      worktreeId: 'repo::worktree-5'
    })

    expect(() => runtime.buildTerminalManagedCliContext('term_ssh_unavailable')).toThrow(
      ManagedCliLauncherUnavailableError
    )
  })

  it('preserves a folder workspace_key instead of coercing it to worktree:', () => {
    const runtime = createRuntime()
    // Why: a folder-derived terminal's pty.worktreeId is ALREADY the exact
    // `folder:<id>` key (folderWorkspaceToWorktree stamps it that way) — a
    // raw unprefixed id here would mask the exact bug this test guards:
    // matching by id-equality against listFolderWorkspaces() never fires
    // once the id is already prefixed.
    stubPty(runtime, 'term_folder', 'pty-folder', {
      connectionId: null,
      isWsl: false,
      worktreeId: 'folder:folder-1'
    })

    const context = runtime.buildTerminalManagedCliContext('term_folder')

    expect(context.workspaceKey).toBe('folder:folder-1')
  })

  it('fails closed instead of fabricating a context for a terminal with no resolvable pty record', () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'resolveLeafForHandle').mockReturnValue(null)

    expect(() => runtime.buildTerminalManagedCliContext('term_untracked')).toThrow(
      'managed_cli_context_terminal_not_found'
    )
  })
})
