/**
 * The RPC boundary of `agent.launch`: who may call it, what it accepts, and which runtime call
 * each of its three factories makes.
 *
 * The last group is where the defect lived. A structured launch must reach
 * `createManagedWorktree` with NO startup agent — an agent-first create makes the startup terminal
 * the agent and puts the structured branch out of reach — and the old `worktree.create` contract
 * must be observably untouched by any of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

const createStructuredSession = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  value: { sessionId: 'sess-1' }
}))

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const { WORKTREE_METHODS } = await import('./worktree')

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function runtimeStub(
  options: {
    settings?: Record<string, unknown>
    createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
    setupReceipt?: {
      startupPolicy: 'start-immediately' | 'wait-for-setup'
      state: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
      terminalHandle?: string
    }
  } = {}
) {
  const worktreeCreateResults = new Map<string, Promise<unknown>>()
  const waitForSetupTerminalCompletion = vi.fn(
    async (_handle: string, _signal?: AbortSignal): Promise<{ exitCode: number | null }> => ({
      exitCode: 0
    })
  )
  return {
    getClientSettings: vi.fn(() => options.settings ?? STRUCTURED_PREFERENCE),
    getStructuredAgentSessionCreateSupport: vi.fn(
      async () => options.createSupport ?? { supported: true }
    ),
    dedupeWorktreeCreate: vi.fn(
      (repo: string, key: string | undefined, run: () => Promise<unknown>) => {
        if (!key) {
          return run()
        }
        const compositeKey = `${repo}\0${key}`
        const existing = worktreeCreateResults.get(compositeKey)
        if (existing) {
          return existing
        }
        const result = run()
        worktreeCreateResults.set(compositeKey, result)
        void result.catch(() => worktreeCreateResults.delete(compositeKey))
        return result
      }
    ),
    showRepo: vi.fn(async () => ({ id: 'repo-1' })),
    createManagedWorktree: vi.fn(async (args: Record<string, unknown>) => ({
      worktree: { id: 'wt-new' },
      startupTerminal: args.startupAgent ? { handle: 'term_agent_first' } : undefined,
      ...(options.setupReceipt ? { setupReceipt: options.setupReceipt } : {})
    })),
    createTerminal: vi.fn(async () => ({ handle: 'term_1' })),
    showTerminal: vi.fn(async (handle: string) => ({ handle, worktreeId: 'wt-7' })),
    isTerminalRunningAgent: vi.fn(async () => true),
    showManagedTerminalWorkspace: vi.fn(async (selector: string) => ({
      id: selector.replace(/^id:/, '')
    })),
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    waitForSetupTerminalCompletion
  }
}

type RuntimeStub = ReturnType<typeof runtimeStub>

function methodNamed<TMethod extends { name: string }, TName extends string>(
  methods: readonly TMethod[],
  name: TName
): Extract<TMethod, { name: TName }> {
  const found = methods.find(
    (entry): entry is Extract<TMethod, { name: TName }> => entry.name === name
  )
  if (!found) {
    throw new Error(`missing method ${name}`)
  }
  return found
}

const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

function parseLaunch(params: unknown) {
  return AGENT_LAUNCH.params.safeParse(params)
}

// The one call the stub cannot satisfy structurally; every method it does implement is asserted.
function rpcContext(runtime: RuntimeStub, context: Partial<RpcContext>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the runtime surface these methods reach, so a method it omits throws on call rather than reading a wrong value.
  return { runtime, ...context } as unknown as RpcContext
}

function createArgs(runtime: RuntimeStub): Record<string, unknown> {
  const [args] = runtime.createManagedWorktree.mock.calls[0] ?? []
  if (!args) {
    throw new Error('createManagedWorktree was not called')
  }
  return args
}

const CAPABLE_CLIENT: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

async function launch(
  params: unknown,
  runtime: RuntimeStub,
  context: Partial<RpcContext> = CAPABLE_CLIENT
) {
  const parsed = parseLaunch(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
}

const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

const IDEMPOTENT_CREATE_LAUNCH = {
  agent: 'claude',
  target: {
    kind: 'create-worktree' as const,
    create: { repo: 'id:repo-1', name: 'task', clientMutationId: 'launch-1' }
  }
}

beforeEach(() => {
  createStructuredSession.mockClear()
})

describe('who may call agent.launch', () => {
  it('refuses a paired client that did not negotiate the capability', async () => {
    const runtime = runtimeStub()
    await expect(
      launch(CREATE_LAUNCH, runtime, {
        clientKind: 'mobile',
        pairedDeviceId: 'device-1',
        clientCapabilities: []
      })
    ).rejects.toThrow('agent_launch_unsupported')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('admits a client that advertises it', async () => {
    const runtime = runtimeStub()
    await launch(CREATE_LAUNCH, runtime)
    expect(runtime.createManagedWorktree).toHaveBeenCalled()
  })

  it('admits an in-process caller, which negotiates nothing', async () => {
    const runtime = runtimeStub()
    await launch(CREATE_LAUNCH, runtime, {})
    expect(runtime.createManagedWorktree).toHaveBeenCalled()
  })
})

describe('what agent.launch accepts', () => {
  it('rejects an agent Orca cannot launch', () => {
    expect(parseLaunch({ ...CREATE_LAUNCH, agent: 'not-an-agent' }).success).toBe(false)
  })

  it('rejects a target that names neither an existing workspace nor a create', () => {
    expect(parseLaunch({ agent: 'claude', target: { kind: 'somewhere' } }).success).toBe(false)
  })

  it('rejects an existing target with no selector', () => {
    expect(
      parseLaunch({ agent: 'claude', target: { kind: 'existing', worktree: '' } }).success
    ).toBe(false)
  })

  it('rejects a create payload with no repo, the same as worktree.create does', () => {
    expect(
      parseLaunch({ agent: 'claude', target: { kind: 'create-worktree', create: { name: 'x' } } })
        .success
    ).toBe(false)
  })

  it('accepts a prompt, seed options and a reused terminal', () => {
    expect(
      parseLaunch({
        agent: 'codex',
        target: { kind: 'existing', worktree: 'id:wt-1' },
        prompt: { text: 'do the thing', delivery: 'draft' },
        sessionOptions: { model: 'gpt-5', effort: 'high' },
        reuseTerminal: { handle: 'term_live' }
      }).success
    ).toBe(true)
  })

  it('validates a reused terminal against the addressed workspace', async () => {
    const runtime = runtimeStub()
    const result = await launch(
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: 'id:wt-7' },
        reuseTerminal: { handle: 'term_live' }
      },
      runtime
    )

    expect(runtime.showTerminal).toHaveBeenCalledWith('term_live')
    expect(runtime.isTerminalRunningAgent).toHaveBeenCalledWith('term_live')
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
  })

  it('rejects a reused terminal from a different workspace before launching', async () => {
    const runtime = runtimeStub()
    runtime.showTerminal.mockResolvedValue({ handle: 'term_live', worktreeId: 'wt-other' })

    await expect(
      launch(
        {
          agent: 'claude',
          target: { kind: 'existing', worktree: 'id:wt-7' },
          reuseTerminal: { handle: 'term_live' }
        },
        runtime
      )
    ).rejects.toThrow('agent_launch_terminal_worktree_mismatch')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects reusing a terminal while creating a new workspace', async () => {
    const runtime = runtimeStub()
    await expect(
      launch({ ...CREATE_LAUNCH, reuseTerminal: { handle: 'term_live' } }, runtime)
    ).rejects.toThrow('agent_launch_reuse_requires_existing_workspace')
    expect(runtime.showTerminal).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('the worktree factory', () => {
  it('creates a structured launch’s worktree with no startup agent', async () => {
    const runtime = runtimeStub()
    const result = await launch(CREATE_LAUNCH, runtime)

    const args = createArgs(runtime)
    expect(args.startupAgent).toBeUndefined()
    expect(args.awaitTerminalProvisioning).toBe(true)
    expect(args.observeSetupCompletion).toBe(true)
    // Still recorded on the workspace: the launch owns the agent whichever surface it settles on.
    expect(args.createdWithAgent).toBe('claude')
    expect(result.outcome.kind).toBe('structured')
  })

  it('deduplicates concurrent launches through surface creation', async () => {
    const runtime = runtimeStub()

    const results = await Promise.all([
      launch(IDEMPOTENT_CREATE_LAUNCH, runtime),
      launch(IDEMPOTENT_CREATE_LAUNCH, runtime)
    ])

    expect(results[0]).toEqual(results[1])
    expect(runtime.dedupeWorktreeCreate).toHaveBeenCalledTimes(2)
    expect(runtime.dedupeWorktreeCreate.mock.calls).toEqual([
      ['id:repo-1', 'agent.launch:launch-1', expect.any(Function)],
      ['id:repo-1', 'agent.launch:launch-1', expect.any(Function)]
    ])
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })

  it('reuses a completed launch result for a sequential retry', async () => {
    const runtime = runtimeStub()

    const first = await launch(IDEMPOTENT_CREATE_LAUNCH, runtime)
    const retried = await launch(IDEMPOTENT_CREATE_LAUNCH, runtime)

    expect(retried).toEqual(first)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })

  it('aborts the setup wait when its bounded timeout expires', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      let setupSignal: AbortSignal | undefined
      runtime.waitForSetupTerminalCompletion.mockImplementation(
        (_handle, signal) =>
          new Promise<{ exitCode: number | null }>((_resolve, reject) => {
            setupSignal = signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )

      const result = await (async () => {
        const pending = launch(CREATE_LAUNCH, runtime)
        await vi.runAllTimersAsync()
        return pending
      })()

      expect(result.outcome.kind).toBe('structured')
      expect(setupSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a setup-gated structured workspace before creating its session', async () => {
    const runtime = runtimeStub({
      setupReceipt: {
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'setup-1'
      }
    })
    const order: string[] = []
    runtime.waitForSetupTerminalCompletion.mockImplementation(async () => {
      order.push('setup-complete')
      return { exitCode: 0 }
    })
    createStructuredSession.mockImplementationOnce(async () => {
      order.push('structured-create')
      return { ok: true as const, value: { sessionId: 'sess-1' } }
    })

    await launch(CREATE_LAUNCH, runtime)

    expect(order).toEqual(['setup-complete', 'structured-create'])
    expect(runtime.waitForSetupTerminalCompletion).toHaveBeenCalledWith(
      'setup-1',
      expect.any(AbortSignal)
    )
  })

  it('keeps agent-first creation for a launch the user wants as a terminal', async () => {
    const runtime = runtimeStub({ settings: {} })
    const result = await launch(CREATE_LAUNCH, runtime)

    const args = createArgs(runtime)
    expect(args.startupAgent).toBe('claude')
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent_first' })
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('drops a stale startupAgent a caller carried over from worktree.create', async () => {
    const runtime = runtimeStub()
    await launch(
      {
        agent: 'claude',
        target: {
          kind: 'create-worktree',
          create: {
            repo: 'id:repo-1',
            name: 'task',
            startupAgent: 'codex',
            startupCommand: 'codex --yolo'
          }
        }
      },
      runtime
    )
    const args = createArgs(runtime)
    expect(args.startupAgent).toBeUndefined()
    expect(args.startup).toBeUndefined()
  })
})

describe('the structured session factory', () => {
  it('creates the session for the worktree the launch just made, and activates it', async () => {
    const runtime = runtimeStub()
    const result = await launch(CREATE_LAUNCH, runtime)

    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(createStructuredSession.mock.calls[0]?.[0]).toMatchObject({
      worktree: 'id:wt-new',
      agent: 'claude',
      activate: true
    })
    expect(result.outcome).toEqual({
      kind: 'structured',
      sessionId: 'sess-1',
      handle: 'structured-agent-session-sess-1'
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('seeds only the options a structured create accepts', async () => {
    const runtime = runtimeStub()
    await launch(
      {
        ...CREATE_LAUNCH,
        sessionOptions: { model: 'sonnet', effort: 'high', fastMode: 'yes' }
      },
      runtime
    )
    expect(createStructuredSession.mock.calls[0]?.[0]).toMatchObject({
      options: { model: 'sonnet', effort: 'high' }
    })
  })
})

describe('the terminal factory', () => {
  it('starts the agent through the runtime launcher when the host refuses a session', async () => {
    const runtime = runtimeStub({ createSupport: { supported: false, reason: 'wsl' } })
    const result = await launch(CREATE_LAUNCH, runtime)

    expect(runtime.createTerminal).toHaveBeenCalledWith('id:wt-new', { startupAgent: 'claude' })
    expect(createStructuredSession).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    // Never a failed launch, and never a silent downgrade.
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
  })

  it('takes an existing workspace without creating one', async () => {
    const runtime = runtimeStub()
    const result = await launch(
      { agent: 'grok', target: { kind: 'existing', worktree: 'id:wt-7' } },
      runtime
    )

    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('id:wt-7')
    // Resolved to an id first: everything below re-prefixes it, so a raw selector reaches the
    // runtime as `id:id:wt-7`.
    expect(runtime.createTerminal).toHaveBeenCalledWith('id:wt-7', { startupAgent: 'grok' })
    expect(result.worktreeId).toBe('wt-7')
  })
})

describe('worktree.create is untouched by any of this', () => {
  it('still answers a startupAgent create with a PTY agent and its handle', async () => {
    const runtime = runtimeStub()
    const create = methodNamed(WORKTREE_METHODS, 'worktree.create')
    const parsed = create.params.safeParse({
      repo: 'id:repo-1',
      name: 'task',
      startupAgent: 'claude'
    })
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
    }

    const result = await create.handler(parsed.data, rpcContext(runtime, {}))

    expect(result).toMatchObject({ agentTerminalHandle: 'term_agent_first' })
    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).toMatchObject({
      startupAgent: 'claude'
    })
    // The route is not consulted on this path, so no client's create can change surface under it.
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(createStructuredSession).not.toHaveBeenCalled()
  })
})
