/** Custom agent ids on the two legacy built-in-only surfaces: the
 *  terminal.createAgentSession runtime handler and the legacy `startupAgent`
 *  terminal-create field. Both must route custom ids through the host
 *  agentLaunch boundary (catalog base resolution, admission, typed failures) —
 *  or fail loudly — never throw the opaque built-in-only-builder error and
 *  never fall through to a bare shell. Built-in ids keep the legacy plan
 *  byte-for-byte for old clients (remote-wire-compatibility rule 1). */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

/** The runtime's private TerminalCreateOptions fields these tests read back. */
type CapturedCreateOptions = {
  agentLaunch?: {
    selection?: { kind: string; agent?: string }
    prompt?: string
    allowEmptyPromptLaunch?: boolean
    promptDelivery?: string
  }
  clientKind?: string
  command?: string
  launchConfig?: unknown
  launchAgent?: string
  launchToken?: string
  agentSessionCreateOperationId?: string
  preAllocatedHandle?: string
}

const CUSTOM_AGENT_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd' as const

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
    agent: CUSTOM_AGENT_ID,
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

function createRuntime() {
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  } as never)
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    resolveWorkspaceAgentLaunch: ReturnType<typeof vi.fn>
    resolveAgentTerminalCreateOptions: (
      workspace: unknown,
      opts: Record<string, unknown>
    ) => Promise<{ kind: string; options?: CapturedCreateOptions; admissionToken?: string }>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return { runtime, internal }
}

describe('createAgentSession with a custom agent id', () => {
  it('routes the launch through the agentLaunch boundary, not the legacy fields', async () => {
    const { runtime } = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.createAgentSession(request(operationId()), { clientKind: 'mobile' })
    ).resolves.toMatchObject({ disposition: 'created' })

    expect(createTerminal).toHaveBeenCalledOnce()
    const opts = createTerminal.mock.calls[0]![1] as CapturedCreateOptions
    expect(opts.agentLaunch).toMatchObject({
      selection: { kind: 'agent', agent: CUSTOM_AGENT_ID },
      prompt: 'do the thing',
      allowEmptyPromptLaunch: true
    })
    expect(opts.clientKind).toBe('mobile')
    // The boundary owns the launch: no client-assembled command may ride along.
    expect(opts.command).toBeUndefined()
    expect(opts.launchConfig).toBeUndefined()
    expect(opts.launchAgent).toBeUndefined()
    // The operation surface identity still pins the spawn for replay dedup.
    expect(opts.agentSessionCreateOperationId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(opts.preAllocatedHandle).toMatch(/^term_/)
  })

  it('threads draft prompt delivery into the boundary request', async () => {
    const { runtime } = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.createAgentSession(request(operationId(), { promptDelivery: 'draft' }))

    const opts = createTerminal.mock.calls[0]![1] as CapturedCreateOptions
    expect(opts.agentLaunch).toMatchObject({ promptDelivery: 'draft' })
  })

  it('refuses an agentArgs override instead of silently dropping it', async () => {
    const { runtime } = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.createAgentSession(request(operationId(), { agentArgs: '--profile x' }))
    ).rejects.toThrow('does not accept an agentArgs override')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('converts a typed pre-spawn launch failure into a loud error, never a bare shell', async () => {
    const { runtime } = createRuntime()
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      agentLaunch: { status: 'failed', failure: { code: 'agent_disabled' } }
    } as never)

    await expect(runtime.createAgentSession(request(operationId()))).rejects.toThrow(
      `Could not launch ${CUSTOM_AGENT_ID} (agent_disabled)`
    )
  })

  it('keeps the legacy client-resolved fields for a built-in id', async () => {
    const { runtime } = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.createAgentSession(request(operationId(), { agent: 'codex' }))

    const opts = createTerminal.mock.calls[0]![1] as CapturedCreateOptions
    expect(opts.agentLaunch).toBeUndefined()
    expect(opts.command).toBeTruthy()
    expect(opts.launchConfig).toBeTruthy()
    expect(opts.launchAgent).toBe('codex')
  })
})

describe('legacy startupAgent with a custom agent id', () => {
  const workspace = {
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }

  it('resolves through the agentLaunch boundary into the launched arm', async () => {
    const { internal } = createRuntime()
    internal.resolveWorkspaceAgentLaunch = vi.fn(async () => ({
      kind: 'resolved',
      admissionToken: 'tok-custom',
      receipt: {
        requestedAgent: CUSTOM_AGENT_ID,
        baseAgent: 'codex',
        notices: [],
        launchToken: 'tok-custom',
        catalogRevision: 1,
        telemetry: { agentKind: 'codex', usedCustomAgent: true }
      },
      fields: {
        command: 'codex --profile custom',
        launchConfig: { agentArgs: '--profile custom', agentEnv: {} },
        launchAgent: 'codex',
        launchToken: 'tok-custom'
      }
    }))

    const resolution = await internal.resolveAgentTerminalCreateOptions(workspace, {
      startupAgent: CUSTOM_AGENT_ID
    })

    expect(internal.resolveWorkspaceAgentLaunch).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({
        selection: { kind: 'agent', agent: CUSTOM_AGENT_ID },
        allowEmptyPromptLaunch: true
      }),
      undefined,
      undefined
    )
    expect(resolution).toMatchObject({
      kind: 'launched',
      admissionToken: 'tok-custom',
      options: {
        command: 'codex --profile custom',
        // The spawn consumes the BUILT-IN base; the custom identity rides the receipt.
        launchAgent: 'codex',
        launchToken: 'tok-custom'
      }
    })
  })

  it('throws the typed failure code instead of falling through to a bare shell', async () => {
    const { internal } = createRuntime()
    internal.resolveWorkspaceAgentLaunch = vi.fn(async () => ({
      kind: 'failed',
      outcome: { status: 'failed', failure: { code: 'agent_removed_from_catalog' } }
    }))

    await expect(
      internal.resolveAgentTerminalCreateOptions(workspace, { startupAgent: CUSTOM_AGENT_ID })
    ).rejects.toThrow(`Could not launch ${CUSTOM_AGENT_ID} (agent_removed_from_catalog)`)
  })

  it('keeps the legacy built-in plan without consulting the boundary', async () => {
    const { internal } = createRuntime()
    internal.resolveWorkspaceAgentLaunch = vi.fn()

    const resolution = await internal.resolveAgentTerminalCreateOptions(workspace, {
      startupAgent: 'codex'
    })

    expect(internal.resolveWorkspaceAgentLaunch).not.toHaveBeenCalled()
    expect(resolution.kind).toBe('options')
    expect(resolution.options?.command).toBeTruthy()
    expect(resolution.options?.launchAgent).toBe('codex')
  })
})
