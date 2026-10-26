import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { AgentLaunchStructuredSessionRefusedError } from './agent-launch-surface-factories'
import type { AgentLaunchSurfaceFactory } from './agent-launch-surface-factories'
import type { AgentLaunchIntent, AgentLaunchResult } from '../../shared/agent-launch-intent'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { readCreatedWorkspaceLaunch } from './agent-launch-created-workspace'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true
}

function harness(options: {
  settings?: Record<string, unknown> | null
  createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
  createSupportThrows?: boolean
  structuredCreateError?: Error
  terminalCreateError?: Error
  deliveredMessageId?: string | null
  terminalPromptDelivered?: boolean
  lineCarriesPrompt?: boolean
  worktreeCreateError?: Error
  onStructuredCreate?: () => void
  onSurfacePublished?: AgentLaunchExecution['onSurfacePublished']
  worktreeOnlyFactory?: boolean
}) {
  const calls: string[] = []
  const carried = (startupPrompt: string | undefined) =>
    startupPrompt && (options.lineCarriesPrompt ?? true) ? { promptRodeLaunchCommand: true } : {}
  const createWorktree = vi.fn(
    async (args: {
      create: Record<string, unknown>
      startupAgent: string | undefined
      promisedAgentChat?: boolean
      startupPrompt?: string
      onWorkspaceCreated?: (worktreeId: string) => void
    }) => {
      calls.push(`createWorktree(startupAgent=${String(args.startupAgent)})`)
      args.onWorkspaceCreated?.('wt-new')
      if (options.worktreeCreateError) {
        throw options.worktreeCreateError
      }
      return {
        worktreeId: 'wt-new',
        workspacePath: '/repo/task',
        connectionId: null,
        startupTerminalHandle: args.startupAgent ? 'term_agent_first' : undefined,
        ...carried(args.startupPrompt)
      }
    }
  )
  const createFolderWorkspace = vi.fn(async (_args: { create: Record<string, unknown> }) => {
    calls.push('createFolderWorkspace')
    return { worktreeId: 'folder:fw-new', workspacePath: '/repo/task', connectionId: null }
  })
  const createRecoveryShell = vi.fn(async (_worktreeId: string) => {
    calls.push('createRecoveryShell')
  })
  const getStructuredAgentSessionCreateSupport = vi.fn(async () => {
    calls.push('createSupport')
    if (options.createSupportThrows) {
      throw new Error('host unreachable')
    }
    return options.createSupport ?? { supported: true }
  })
  const createStructuredSession = vi.fn(
    async (args: Parameters<AgentLaunchSurfaceFactory['createStructuredSession']>[0]) => {
      calls.push('createStructuredSession')
      options.onStructuredCreate?.()
      if (options.structuredCreateError) {
        throw options.structuredCreateError
      }
      return {
        sessionId: 'sess-1',
        handle: 'handle_structured',
        fence: 4,
        ...(args.firstMessage && options.deliveredMessageId !== null
          ? { firstMessage: { clientMessageId: 'msg-1' } }
          : {})
      }
    }
  )
  const createTerminalAgent = vi.fn(async (args: { startupPrompt?: string }) => {
    calls.push('createTerminalAgent')
    if (options.terminalCreateError) {
      throw options.terminalCreateError
    }
    return { handle: 'term_1', ...carried(args.startupPrompt) }
  })
  const deliverTerminalPrompt = vi.fn(async () => {
    calls.push('deliverTerminalPrompt')
    return options.terminalPromptDelivered ?? true
  })
  const runtime = {
    requireStore: () => ({
      getSettings: () => (options.settings === undefined ? STRUCTURED_PREFERENCE : options.settings)
    }),
    getStructuredAgentSessionCreateSupport
  }
  return {
    calls,
    runtime,
    createWorktree,
    createFolderWorkspace,
    createRecoveryShell,
    createStructuredSession,
    createTerminalAgent,
    deliverTerminalPrompt,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the two runtime methods the executor reaches, and each test asserts the calls made, so an omitted method throws rather than reading a wrong value.
        runtime: runtime as unknown as AgentLaunchExecution['runtime'],
        intent,
        surfaces: {
          createStructuredSession,
          createTerminalAgent,
          deliverTerminalPrompt
        },
        workspaces: options.worktreeOnlyFactory
          ? { createWorktree, createRecoveryShell }
          : { createWorktree, createFolderWorkspace, createRecoveryShell },
        ...(options.onSurfacePublished ? { onSurfacePublished: options.onSurfacePublished } : {})
      })
  }
}

const CREATE_INTENT: AgentLaunchIntent = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

describe('a structured launch that creates its own worktree', () => {
  it('keeps its live inventory through publication and clears it after launch', async () => {
    let duringCreate: unknown
    let duringPublication: unknown
    const h = harness({
      onStructuredCreate: () => (duringCreate = readCreatedWorkspaceLaunch(h.runtime, 'wt-new')),
      onSurfacePublished: () =>
        (duringPublication = readCreatedWorkspaceLaunch(h.runtime, 'wt-new'))
    })
    await h.run({ ...CREATE_INTENT, prompt: { text: 'start', delivery: 'submit' } })
    expect(duringCreate).toMatchObject({ agent: 'claude', launchId: expect.any(String) })
    expect(duringPublication).toEqual(duringCreate)
    expect(readCreatedWorkspaceLaunch(h.runtime, 'wt-new')).toBeUndefined()
  })

  it('recovers once and releases intent when creation fails after metadata registration', async () => {
    const failure = new Error('materialization failed')
    const h = harness({ worktreeCreateError: failure })
    await expect(h.run(CREATE_INTENT)).rejects.toBe(failure)
    expect(h.createRecoveryShell).toHaveBeenCalledExactlyOnceWith('wt-new')
    expect(h.createStructuredSession).not.toHaveBeenCalled()
    expect(readCreatedWorkspaceLaunch(h.runtime, 'wt-new')).toBeUndefined()
  })

  it('creates the worktree with no startup agent, then asks the host, then opens a session', async () => {
    const h = harness({})
    const result = await h.run(CREATE_INTENT)

    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession'
    ])
    expect(result.outcome).toEqual({
      kind: 'structured',
      sessionId: 'sess-1',
      handle: 'handle_structured'
    })
    expect(result.worktreeId).toBe('wt-new')
    expect(result.receipt.mode).toBe('structured')
    expect(h.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ promisedAgentChat: true })
    )
  })

  it.each([undefined, 'chat'] as const)(
    'keeps the created worktree on host refusal (%s)',
    async (surface) => {
      const h = harness({ createSupport: { supported: false, reason: 'wsl' } })
      const result = await h.run({ ...CREATE_INTENT, surface })

      expect(h.calls).toEqual([
        'createWorktree(startupAgent=undefined)',
        'createSupport',
        'createTerminalAgent'
      ])
      expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
      expect(result.worktreeId).toBe('wt-new')
      expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
      expect(result.receipt.detail).toContain(surface ? 'You asked for' : 'Your default is')
    }
  )

  it('falls back to a terminal when the host cannot be reached at all', async () => {
    const h = harness({ createSupportThrows: true })
    const result = await h.run(CREATE_INTENT)
    expect(result.outcome.kind).toBe('terminal')
    expect(result.receipt).toMatchObject({ reason: 'structured_support_unknown' })
  })

  it('keeps Pi on the terminal path when its RPC version is unsupported', async () => {
    const h = harness({ createSupport: { supported: false, reason: 'agent' } })
    const result = await h.run({
      ...CREATE_INTENT,
      agent: 'pi',
      prompt: { text: 'continue my task', delivery: 'submit' }
    })
    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createTerminalAgent'
    ])
    expect(h.createStructuredSession).not.toHaveBeenCalled()
    expect(h.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        startupPrompt: 'continue my task'
      })
    )
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toMatchObject({
      mode: 'terminal',
      reason: 'structured_unsupported_on_host'
    })
  })

  it('falls back only for a definitive structured refusal after the worktree exists', async () => {
    const h = harness({
      structuredCreateError: new AgentLaunchStructuredSessionRefusedError(
        'structured_agent_session_unsupported',
        'unsupported'
      )
    })
    const result = await h.run(CREATE_INTENT)

    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession',
      'createTerminalAgent'
    ])
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toMatchObject({
      mode: 'terminal',
      reason: 'structured_unsupported_on_host'
    })
  })

  it.each([
    [
      'unknown chat creation',
      {
        structuredCreateError: new AgentLaunchStructuredSessionRefusedError(
          'agent_session_operation_unknown',
          'unknown'
        )
      },
      0
    ],
    [
      'host downgrade terminal failure',
      {
        createSupport: { supported: false, reason: 'wsl' as const },
        terminalCreateError: new Error('spawn failed')
      },
      1
    ],
    [
      'definitive refusal fallback failure',
      {
        structuredCreateError: new AgentLaunchStructuredSessionRefusedError(
          'structured_agent_session_unsupported',
          'unsupported'
        ),
        terminalCreateError: new Error('spawn failed')
      },
      1
    ]
  ] as const)('leaves a shell after %s', async (_label, options, agentStarts) => {
    const h = harness(options)
    await expect(h.run(CREATE_INTENT)).rejects.toThrow()
    expect(h.createRecoveryShell).toHaveBeenCalledWith('wt-new')
    expect(h.createTerminalAgent).toHaveBeenCalledTimes(agentStarts)
  })

  it('creates a folder workspace, then opens its structured session there', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
    })

    expect(h.calls).toEqual(['createFolderWorkspace', 'createSupport', 'createStructuredSession'])
    expect(h.createFolderWorkspace).toHaveBeenCalledWith({ create: { projectGroupId: 'group-1' } })
    expect(result.worktreeId).toBe('folder:fw-new')
    expect(result.outcome.kind).toBe('structured')
  })

  it('starts a terminal agent in a new folder workspace, not agent-first', async () => {
    const h = harness({ settings: null })
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
    })

    expect(h.calls).toEqual(['createFolderWorkspace', 'createTerminalAgent'])
    expect(result).toMatchObject({ worktreeId: 'folder:fw-new', outcome: { kind: 'terminal' } })
  })

  it('refuses a folder create from a factory that cannot make one, before anything is created', async () => {
    const h = harness({ worktreeOnlyFactory: true })
    await expect(
      h.run({
        agent: 'claude',
        target: { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
      })
    ).rejects.toThrow('agent_launch_workspace_factory_required')
    expect(h.calls).toEqual([])
  })

  it('strips a stale startupAgent out of a migrated create payload', async () => {
    const h = harness({})
    await h.run({
      agent: 'claude',
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:repo-1', name: 'task', startupAgent: 'claude', startupDraft: 'url' }
      }
    })
    const passed = h.createWorktree.mock.calls[0]?.[0]
    expect(passed?.create).not.toHaveProperty('startupAgent')
    expect(passed?.create).not.toHaveProperty('startupDraft')
    expect(passed?.create).toMatchObject({ repo: 'id:repo-1', name: 'task' })
  })
})

describe('a launch the user did not ask to be structured', () => {
  it('creates the worktree agent-first and never asks the host', async () => {
    const h = harness({ settings: null })
    const result = await h.run(CREATE_INTENT)

    expect(h.calls).toEqual(['createWorktree(startupAgent=claude)'])
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent_first' })
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'user_default' })
    expect(h.createWorktree.mock.calls[0]?.[0]).not.toHaveProperty('promisedAgentChat')
  })
})

describe("a caller's chat default in place of the host's", () => {
  const EXISTING: AgentLaunchIntent = {
    agent: 'claude',
    target: { kind: 'existing', worktree: 'wt-7' }
  }

  it('opens a chat when the caller says so, though the host setting is off', async () => {
    const h = harness({ settings: null })
    const result = await h.run({ ...EXISTING, nativeChatDefault: true })
    expect(result.outcome.kind).toBe('structured')
  })

  it('opens a terminal when the caller says so, though the host setting is on', async () => {
    const h = harness({})
    const result = await h.run({ ...EXISTING, nativeChatDefault: false })
    expect(result.outcome.kind).toBe('terminal')
    expect(h.calls).not.toContain('createSupport')
  })

  it('still lets the host refuse a chat it cannot create', async () => {
    const h = harness({ settings: null, createSupport: { supported: false, reason: 'agent' } })
    const result = await h.run({ ...EXISTING, nativeChatDefault: true })
    expect(result.outcome.kind).toBe('terminal')
  })
})

describe('a launch into a workspace that already exists', () => {
  it('opens a session without creating anything', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'codex', target: { kind: 'existing', worktree: 'wt-7' } })
    expect(h.calls).toEqual(['createSupport', 'createStructuredSession'])
    expect(h.createWorktree).not.toHaveBeenCalled()
    expect(result.worktreeId).toBe('wt-7')
  })

  it.each(['claude', 'grok'] as const)(
    'reuses a running %s terminal without creating or asking',
    async (agent) => {
      const h = harness({})
      const result = await h.run({
        agent,
        target: { kind: 'existing', worktree: 'wt-7' },
        reuseTerminal: { handle: 'term_live' }
      })
      expect(h.calls).toEqual([])
      expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
      expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'reused_terminal' })
    }
  )
})

describe('an agent with no structured session', () => {
  it('stays a terminal without asking the host', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'gemini', target: { kind: 'existing', worktree: 'wt-7' } })
    expect(h.calls).toEqual(['createTerminalAgent'])
    expect(result.receipt).toMatchObject({ reason: 'agent_without_structured_session' })
  })

  it('asks the host for an agent it registered beyond Claude and Codex', async () => {
    const h = harness({})
    const result = await h.run({ ...CREATE_INTENT, agent: 'grok' })
    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession'
    ])
    expect(result.receipt).toMatchObject({ mode: 'structured' })
  })
})

describe('the prompt receipt', () => {
  const SUBMIT = { text: 'do the thing', delivery: 'submit' } as const

  it('commits a submitted prompt to the session the launch created and names the row', async () => {
    const h = harness({})
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'journaled', messageId: 'msg-1' })
    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession'
    ])
    expect(h.createStructuredSession).toHaveBeenCalledWith(
      expect.objectContaining({
        firstMessage: {
          clientMessageId: expect.any(String),
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: SUBMIT.text }] }
        }
      })
    )
  })

  it('keeps a missing commit receipt unconfirmed', async () => {
    const h = harness({ deliveredMessageId: null })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'unconfirmed' })
  })

  it('leaves a draft with the caller, because the host has no composer to hold one', async () => {
    const h = harness({})
    const result = await h.run({
      ...CREATE_INTENT,
      prompt: { text: 'do the thing', delivery: 'draft' }
    })
    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(h.createStructuredSession.mock.calls[0]?.[0].firstMessage).toBeUndefined()
  })

  it('omits the receipt when no prompt was requested', async () => {
    const h = harness({})
    expect((await h.run(CREATE_INTENT)).prompt).toBeUndefined()
  })
})

describe('delivering a launch prompt to a terminal agent', () => {
  const SUBMIT = { text: 'do the thing', delivery: 'submit' } as const

  it('folds an argv agent’s prompt into the command that starts it, never a paste', async () => {
    const h = harness({ createSupport: { supported: false, reason: 'wsl' } })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.outcome.kind).toBe('terminal')
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.createTerminalAgent.mock.calls[0]?.[0]).toMatchObject({
      startupPrompt: 'do the thing'
    })
    expect(h.deliverTerminalPrompt).not.toHaveBeenCalled()
  })

  it('writes a stdin-after-start agent’s prompt into its PTY, because its CLI takes none', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'aider',
      target: { kind: 'existing', worktree: 'wt-7' },
      prompt: SUBMIT
    })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith({
      handle: 'term_1',
      agent: 'aider',
      freshLaunch: true,
      prompt: SUBMIT
    })
    expect(h.createTerminalAgent.mock.calls[0]?.[0]).not.toHaveProperty('startupPrompt')
  })

  it('carries an argv prompt through an agent-first create, which builds the startup command', async () => {
    const h = harness({ settings: null })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent_first' })
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.createWorktree.mock.calls[0]?.[0]).toMatchObject({
      startupAgent: 'claude',
      startupPrompt: 'do the thing'
    })
    expect(h.deliverTerminalPrompt).not.toHaveBeenCalled()
  })

  it('pastes an argv agent’s prompt after start when the surface reports its typed line could not carry it', async () => {
    const h = harness({
      createSupport: { supported: false, reason: 'wsl' },
      lineCarriesPrompt: false
    })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.createTerminalAgent.mock.calls[0]?.[0]).toMatchObject({
      startupPrompt: 'do the thing'
    })
    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith({
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      prompt: SUBMIT
    })
  })

  it('pastes into an agent-first create’s startup terminal when its typed line could not carry the prompt', async () => {
    const h = harness({ settings: null, lineCarriesPrompt: false })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith({
      handle: 'term_agent_first',
      agent: 'claude',
      freshLaunch: true,
      prompt: SUBMIT
    })
  })

  it('writes into a reused terminal, whose process started before the launch existed', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7' },
      reuseTerminal: { handle: 'term_existing' },
      prompt: SUBMIT
    })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith({
      handle: 'term_existing',
      agent: 'claude',
      freshLaunch: false,
      prompt: SUBMIT
    })
  })

  it('under-claims as not delivered when the write did not land', async () => {
    const h = harness({ terminalPromptDelivered: false })
    const result = await h.run({
      agent: 'aider',
      target: { kind: 'existing', worktree: 'wt-7' },
      prompt: SUBMIT
    })
    expect(result.outcome.kind).toBe('terminal')
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'not-delivered' })
  })

  it('leaves a terminal draft with the caller, because the TUI composer is not the host’s to fill', async () => {
    const h = harness({ settings: null })
    const result = await h.run({
      ...CREATE_INTENT,
      prompt: { text: 'do the thing', delivery: 'draft' }
    })
    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(h.deliverTerminalPrompt).not.toHaveBeenCalled()
    expect(h.createWorktree.mock.calls[0]?.[0]).not.toHaveProperty('startupPrompt')
  })
})

describe('a launch into an existing workspace, by workspace kind', () => {
  it('opens a structured session in the floating workspace', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: FLOATING_TERMINAL_WORKTREE_ID }
    })

    expect(h.createStructuredSession).toHaveBeenCalled()
    expect(result.outcome).toMatchObject({ kind: 'structured' })
  })

  it('still opens a structured session in a folder workspace', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'folder:fw-1' }
    })

    expect(h.createTerminalAgent).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({
      kind: 'structured',
      sessionId: 'sess-1',
      handle: 'handle_structured'
    })
    expect(result.receipt).toMatchObject({ mode: 'structured' })
  })

  it('still opens a structured session in a git worktree', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: { kind: 'existing', worktree: 'wt-7' } })

    expect(result.outcome.kind).toBe('structured')
    expect(result.receipt).toMatchObject({ mode: 'structured' })
  })
})

describe('caller-supplied launch inputs', () => {
  const EXISTING = { kind: 'existing' as const, worktree: 'wt-7' }

  it('downgrades a structured preference to a terminal when the launch names a cwd', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, cwd: '/repo/packages/api' })

    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toEqual({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'tui_launch_command',
      detail:
        'Your default is a structured chat session, but it asks to start in a folder other than its workspace; started a terminal agent instead.'
    })
    expect(h.createStructuredSession).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', 'claude-wrapper'],
    ['codex', 'codex-nightly'],
    ['claude', 'npx claude'],
    ['codex', 'wrapper --arg'],
    ['claude', '/missing/claude'],
    ['codex', './codex']
  ] as const)('opens a structured %s session despite launch command %s', async (agent, command) => {
    const h = harness({
      settings: { ...STRUCTURED_PREFERENCE, agentCmdOverrides: { [agent]: command } }
    })
    const result = await h.run({ agent, target: EXISTING })

    expect(result.outcome.kind).toBe('structured')
    expect(result.receipt).toMatchObject({ mode: 'structured', reason: 'user_default' })
    expect(h.createTerminalAgent).not.toHaveBeenCalled()
  })

  it('still opens a structured session when the cwd names the workspace root', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7', workspacePath: '/repo' },
      cwd: '/repo/'
    })
    expect(result.outcome.kind).toBe('structured')
    expect(result.receipt).toMatchObject({ mode: 'structured' })
  })

  it('still downgrades for a subdirectory of a resolved root', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7', workspacePath: '/repo' },
      cwd: '/repo/packages/api'
    })
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'tui_launch_command' })
  })

  it('still opens a structured session when the cwd is only whitespace', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, cwd: '   ' })

    expect(result.outcome.kind).toBe('structured')
  })

  it('hands cwd, agentArgs and launchSource to the terminal it creates', async () => {
    const h = harness({ settings: null })
    await h.run({
      agent: 'claude',
      target: EXISTING,
      cwd: '/repo/packages/api',
      agentArgs: '--model opus',
      launchSource: 'source_control_recovery'
    })

    expect(h.createTerminalAgent.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/repo/packages/api',
      agentArgs: '--model opus',
      launchSource: 'source_control_recovery'
    })
  })

  it('forwards an explicit "no arguments" rather than dropping it as falsy', async () => {
    const h = harness({ settings: null })
    await h.run({ agent: 'claude', target: EXISTING, agentArgs: null })

    expect(h.createTerminalAgent.mock.calls[0]?.[0]).toHaveProperty('agentArgs', null)
  })

  it('omits agentArgs entirely when the caller sent none, so the settings default still applies', async () => {
    const h = harness({ settings: null })
    await h.run({ agent: 'claude', target: EXISTING })

    expect(h.createTerminalAgent.mock.calls[0]?.[0]).not.toHaveProperty('agentArgs')
  })

  it('warns that a structured session ignored the launch arguments, without changing the route', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, agentArgs: '--model opus' })

    expect(result.outcome.kind).toBe('structured')
    expect(result.warning).toContain('per-launch argument override was ignored')
  })

  it('warns when a structured session ignored an explicit "no arguments" too', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, agentArgs: null })

    expect(result.warning).toContain('per-launch argument override was ignored')
  })

  it('leaves a structured launch unwarned when it carried no arguments at all', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING })

    expect(result.warning).toBeUndefined()
  })
})

describe('the surface is published as the launch stands, before its prompt is delivered', () => {
  const PROMPTED_EXISTING: AgentLaunchIntent = {
    agent: 'claude',
    target: { kind: 'existing', worktree: 'wt-7' },
    prompt: { text: 'fix the build', delivery: 'submit' }
  }

  function publishing(options: Parameters<typeof harness>[0]) {
    const published: AgentLaunchResult[] = []
    const launch = harness({
      ...options,
      onSurfacePublished: (surface) => {
        launch.calls.push('published')
        published.push(surface)
      }
    })
    return { launch, published }
  }

  it('records a prompt still owed as unconfirmed, then delivers it', async () => {
    const { launch, published } = publishing({ settings: {}, lineCarriesPrompt: false })

    const result = await launch.run(PROMPTED_EXISTING)

    expect(launch.calls).toEqual(['createTerminalAgent', 'published', 'deliverTerminalPrompt'])
    expect(published).toEqual([
      {
        outcome: { kind: 'terminal', handle: 'term_1' },
        worktreeId: 'wt-7',
        receipt: result.receipt,
        prompt: { delivery: 'submit', outcome: 'unconfirmed' }
      }
    ])
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
  })

  it('records a draft as not delivered, since the host never delivers one', async () => {
    const { launch, published } = publishing({ settings: {}, lineCarriesPrompt: false })

    const result = await launch.run({
      ...PROMPTED_EXISTING,
      prompt: { text: 'fix the build', delivery: 'draft' }
    })

    expect(published[0]?.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
  })

  it('records a prompt the launch command carried as already handed over', async () => {
    const { launch, published } = publishing({ settings: {}, lineCarriesPrompt: true })

    const result = await launch.run(PROMPTED_EXISTING)

    expect(published[0]?.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(published[0]).toEqual(result)
    expect(launch.deliverTerminalPrompt).not.toHaveBeenCalled()
  })

  it('publishes a chat with its first message receipt', async () => {
    const { launch, published } = publishing({})

    const result = await launch.run(PROMPTED_EXISTING)

    expect(launch.calls).toEqual(['createSupport', 'createStructuredSession', 'published'])
    expect(published[0]).toEqual(result)
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'journaled', messageId: 'msg-1' })
  })
})

describe('a new local worktree whose startup terminal did not come up', () => {
  it('opens its agent in the view a local workspace allows, as an existing one would', async () => {
    const h = harness({
      settings: { experimentalNativeChat: true }
    })
    h.createWorktree.mockImplementationOnce(async () => ({
      worktreeId: 'wt-new',
      workspacePath: '/repo/task',
      connectionId: null,
      startupTerminalHandle: undefined
    }))

    await h.run({ ...CREATE_INTENT, agent: 'opencode' })

    expect(h.createStructuredSession).toHaveBeenCalled()
    expect(h.createTerminalAgent).not.toHaveBeenCalled()
  })
})

describe('explicit chat settlement uses resolved facts and launch effects', () => {
  it.each(['create-worktree', 'create-folder-workspace'] as const)(
    'settles root and custom cwd after %s without losing launch inputs',
    async (kind) => {
      for (const cwd of ['.', '/repo/task', 'packages/api']) {
        const h = harness({ settings: {} })
        const result = await h.run({
          agent: 'claude',
          surface: 'chat',
          cwd,
          target: { kind, create: {} },
          sessionOptions: { model: 'opus' },
          prompt: { text: 'do the task', delivery: 'submit' }
        })
        expect(result.outcome.kind).toBe(cwd === 'packages/api' ? 'terminal' : 'structured')
        if (cwd === 'packages/api') {
          expect(result.receipt.detail).toContain('You asked for')
          expect(h.createTerminalAgent).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd,
              options: { model: 'opus' },
              startupPrompt: 'do the task'
            })
          )
          expect(h.createStructuredSession).not.toHaveBeenCalled()
        }
      }
    }
  )

  it('refuses a definitive no-session factory answer only before workspace creation', async () => {
    const options = {
      structuredCreateError: new AgentLaunchStructuredSessionRefusedError(
        'structured_agent_session_unsupported',
        'unsupported'
      )
    }
    const existing = harness(options)
    await expect(
      existing.run({
        agent: 'claude',
        surface: 'chat',
        target: { kind: 'existing', worktree: 'wt-7' }
      })
    ).rejects.toMatchObject({ code: 'agent_launch_surface_unavailable' })
    expect(existing.createTerminalAgent).not.toHaveBeenCalled()
  })
})
