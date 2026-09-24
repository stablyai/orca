/**
 * The executor's ordering contract, which is the defect this module exists to remove.
 *
 * The old shape created a new worktree agent-first, so its startup terminal WAS the agent and the
 * structured branch below it could not be reached for any new worktree. The assertions that matter
 * here are therefore about *order and arguments*, not just the returned mode: a structured launch
 * must create the worktree with `startupAgent: undefined`, and it must ask the host only after the
 * workspace exists.
 */

import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { AgentLaunchStructuredSessionRefusedError } from './agent-launch-surface-factories'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function harness(options: {
  settings?: Record<string, unknown> | null
  createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
  createSupportThrows?: boolean
  structuredCreateError?: Error
  deliveredMessageId?: string | null
  terminalPromptDelivered?: boolean
}) {
  const calls: string[] = []
  const createWorktree = vi.fn(
    async (args: {
      create: Record<string, unknown>
      startupAgent: string | undefined
      startupPrompt?: string
    }) => {
      calls.push(`createWorktree(startupAgent=${String(args.startupAgent)})`)
      return {
        worktreeId: 'wt-new',
        startupTerminalHandle: args.startupAgent ? 'term_agent_first' : undefined
      }
    }
  )
  const getStructuredAgentSessionCreateSupport = vi.fn(async () => {
    calls.push('createSupport')
    if (options.createSupportThrows) {
      throw new Error('host unreachable')
    }
    return options.createSupport ?? { supported: true }
  })
  const createStructuredSession = vi.fn(async () => {
    calls.push('createStructuredSession')
    if (options.structuredCreateError) {
      throw options.structuredCreateError
    }
    return { sessionId: 'sess-1', handle: 'handle_structured', fence: 4 }
  })
  const createTerminalAgent = vi.fn(async (_args: { startupPrompt?: string }) => {
    calls.push('createTerminalAgent')
    return { handle: 'term_1' }
  })
  const deliverStructuredPrompt = vi.fn(async () => {
    calls.push('deliverStructuredPrompt')
    return options.deliveredMessageId === undefined ? 'msg-1' : options.deliveredMessageId
  })
  const deliverTerminalPrompt = vi.fn(async () => {
    calls.push('deliverTerminalPrompt')
    return options.terminalPromptDelivered ?? true
  })
  const runtime = {
    getClientSettings: () =>
      options.settings === undefined ? STRUCTURED_PREFERENCE : options.settings,
    getStructuredAgentSessionCreateSupport
  }
  return {
    calls,
    createWorktree,
    createStructuredSession,
    createTerminalAgent,
    deliverStructuredPrompt,
    deliverTerminalPrompt,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the two runtime methods the executor reaches, and each test asserts the calls made, so an omitted method throws rather than reading a wrong value.
        runtime: runtime as unknown as AgentLaunchExecution['runtime'],
        intent,
        surfaces: {
          createStructuredSession,
          createTerminalAgent,
          deliverStructuredPrompt,
          deliverTerminalPrompt
        },
        workspaces: { createWorktree }
      })
  }
}

const CREATE_INTENT: AgentLaunchIntent = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

describe('a structured launch that creates its own worktree', () => {
  it('creates the worktree with no startup agent, then asks the host, then opens a session', async () => {
    const h = harness({})
    const result = await h.run(CREATE_INTENT)

    // The whole defect in one assertion: the worktree must not be created agent-first.
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
  })

  it('asks the host only after the workspace exists, never before', async () => {
    const h = harness({})
    await h.run(CREATE_INTENT)
    expect(h.calls.indexOf('createSupport')).toBeGreaterThan(
      h.calls.indexOf('createWorktree(startupAgent=undefined)')
    )
  })

  it('falls back to a terminal in the worktree it just created when the host refuses', async () => {
    const h = harness({ createSupport: { supported: false, reason: 'wsl' } })
    const result = await h.run(CREATE_INTENT)

    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createTerminalAgent'
    ])
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    // Not a failed launch, and the workspace is the one just created.
    expect(result.worktreeId).toBe('wt-new')
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
  })

  it('falls back to a terminal when the host cannot be reached at all', async () => {
    const h = harness({ createSupportThrows: true })
    const result = await h.run(CREATE_INTENT)
    expect(result.outcome.kind).toBe('terminal')
    expect(result.receipt).toMatchObject({ reason: 'structured_support_unknown' })
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

  it('does not create a duplicate terminal when structured creation is unknown', async () => {
    const h = harness({
      structuredCreateError: new AgentLaunchStructuredSessionRefusedError(
        'agent_session_operation_unknown',
        'unknown'
      )
    })

    await expect(h.run(CREATE_INTENT)).rejects.toThrow('unknown')
    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession'
    ])
  })

  it('strips a stale startupAgent out of a migrated create payload', async () => {
    const h = harness({})
    await h.run({
      agent: 'claude',
      target: {
        kind: 'create-worktree',
        // Exactly what mobile sends `worktree.create` today.
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

    // Agent-first is preserved for PTY launches: it is what sequences the agent's startup command
    // behind the setup runner, so the wait-for-setup gate comes for free.
    expect(h.calls).toEqual(['createWorktree(startupAgent=claude)'])
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent_first' })
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'user_default' })
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

  it('reuses a running terminal without creating or asking', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7' },
      reuseTerminal: { handle: 'term_live' }
    })
    expect(h.calls).toEqual([])
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'reused_terminal' })
  })
})

describe('an agent with no structured session', () => {
  it('stays a terminal without asking the host', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'grok', target: { kind: 'existing', worktree: 'wt-7' } })
    expect(h.calls).toEqual(['createTerminalAgent'])
    expect(result.receipt).toMatchObject({ reason: 'agent_without_structured_session' })
  })
})

describe('the prompt receipt', () => {
  const SUBMIT = { text: 'do the thing', delivery: 'submit' } as const

  it('commits a submitted prompt to the session the launch created and names the row', async () => {
    const h = harness({})
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'journaled', messageId: 'msg-1' })
    // Delivery is sequenced after the surface exists; there is nothing to send into before that.
    expect(h.calls).toEqual([
      'createWorktree(startupAgent=undefined)',
      'createSupport',
      'createStructuredSession',
      'deliverStructuredPrompt'
    ])
    // The send must name the lease the create was admitted under, not one re-read later.
    expect(h.deliverStructuredPrompt).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      fence: 4,
      prompt: SUBMIT
    })
  })

  it('under-claims as not delivered when nothing was committed', async () => {
    const h = harness({ deliveredMessageId: null })
    const result = await h.run({ ...CREATE_INTENT, prompt: SUBMIT })
    // A resend costs a duplicate; claiming a row that does not exist loses the text silently.
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'not-delivered' })
  })

  it('leaves a draft with the caller, because the host has no composer to hold one', async () => {
    const h = harness({})
    const result = await h.run({
      ...CREATE_INTENT,
      prompt: { text: 'do the thing', delivery: 'draft' }
    })
    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
    expect(h.deliverStructuredPrompt).not.toHaveBeenCalled()
  })

  it('omits the receipt when no prompt was requested', async () => {
    const h = harness({})
    expect((await h.run(CREATE_INTENT)).prompt).toBeUndefined()
  })
})

/**
 * A terminal takes its prompt one of two ways, and which one is not a preference: an agent whose
 * CLI accepts a prompt argument must get it on argv, because that is the transport that survives
 * multi-line and special-character text. Only an agent with no such argument is written to as
 * keystrokes. `claude` is argv-mode, `aider` is `stdin-after-start` — the two halves of the table.
 */
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
    // The text was in the process's argv at exec time; a paste on top would be a second copy.
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
      prompt: SUBMIT
    })
    // Folding it into argv would have appended it as an argument the CLI does not accept.
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

  it('writes into a reused terminal, whose process started before the launch existed', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7' },
      reuseTerminal: { handle: 'term_existing' },
      prompt: SUBMIT
    })

    // Argv is unreachable here however argv-friendly the agent is: the process already exists.
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(h.deliverTerminalPrompt).toHaveBeenCalledWith({
      handle: 'term_existing',
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
    // A launch whose agent is running must not fail because its text did not; the caller resends.
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
    // A draft must not be submitted as a turn by riding the launch command either.
    expect(h.createWorktree.mock.calls[0]?.[0]).not.toHaveProperty('startupPrompt')
  })
})

/**
 * The kind is read off the resolved workspace id, so a workspace with nowhere to keep a session is
 * decided here rather than offered to a host probe that cannot answer for it.
 */
describe('a launch into an existing workspace, by workspace kind', () => {
  it('runs the floating workspace as a terminal, never a structured session', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: FLOATING_TERMINAL_WORKTREE_ID }
    })

    // The invariant, not the call order: the floating sentinel has no session store to open into.
    expect(h.createStructuredSession).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toMatchObject({
      mode: 'terminal',
      reason: 'structured_unsupported_on_host'
    })
  })

  it('still opens a structured session in a folder workspace', async () => {
    const h = harness({})
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'folder:fw-1' }
    })

    // A folder workspace has no git worktree either; it must not be swept up with the sentinel.
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

/**
 * The launch inputs the host cannot derive for itself.
 *
 * The pair is deliberately asymmetric and the asymmetry is the contract: a requested `cwd` is
 * something only a terminal can apply, so it decides the route; launch arguments are a TUI concern
 * the structured providers version independently, so they do NOT decide the route and a structured
 * launch that received some has to admit it ignored them.
 */
describe('caller-supplied launch inputs', () => {
  const EXISTING = { kind: 'existing' as const, worktree: 'wt-7' }

  it('downgrades a structured preference to a terminal when the launch names a cwd', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, cwd: '/repo/packages/api' })

    // A structured session runs in its workspace, so honouring the cwd and honouring the
    // preference are mutually exclusive; the receipt has to say which one lost.
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
    expect(result.receipt).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'tui_launch_command'
    })
    expect(h.createStructuredSession).not.toHaveBeenCalled()
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

    // `null` means the caller wants none; dropping it here would silently restore the user's
    // configured default, which is the opposite of what was asked.
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
    expect(result.warning).toContain('does not apply launch arguments')
  })

  it('warns when a structured session ignored an explicit "no arguments" too', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING, agentArgs: null })

    // The structured path reads the bypass-permissions bit from the user's SETTINGS default, so a
    // caller that asked for no arguments can still get a session with more permission than it asked
    // for. Staying silent about that is the failure mode worth a test.
    expect(result.warning).toContain('does not apply launch arguments')
  })

  it('leaves a structured launch unwarned when it carried no arguments at all', async () => {
    const h = harness({})
    const result = await h.run({ agent: 'claude', target: EXISTING })

    expect(result.warning).toBeUndefined()
  })
})
