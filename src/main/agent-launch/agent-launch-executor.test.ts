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
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function harness(options: {
  settings?: Record<string, unknown> | null
  createSupport?: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }
  createSupportThrows?: boolean
}) {
  const calls: string[] = []
  const createWorktree = vi.fn(
    async (args: { create: Record<string, unknown>; startupAgent: string | undefined }) => {
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
    return { sessionId: 'sess-1', handle: 'handle_structured' }
  })
  const createTerminalAgent = vi.fn(async () => {
    calls.push('createTerminalAgent')
    return { handle: 'term_1' }
  })
  const runtime = {
    getClientSettings: () =>
      (options.settings === undefined ? STRUCTURED_PREFERENCE : options.settings) as never,
    getStructuredAgentSessionCreateSupport
  }
  return {
    calls,
    createWorktree,
    createStructuredSession,
    createTerminalAgent,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        runtime: runtime as unknown as AgentLaunchExecution['runtime'],
        intent,
        surfaces: { createStructuredSession, createTerminalAgent },
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
  it('reports a requested prompt as undelivered rather than omitting it', async () => {
    const h = harness({})
    const result = await h.run({
      ...CREATE_INTENT,
      prompt: { text: 'do the thing', delivery: 'draft' }
    })
    expect(result.prompt).toEqual({ delivery: 'draft', delivered: false })
  })

  it('omits the receipt when no prompt was requested', async () => {
    const h = harness({})
    expect((await h.run(CREATE_INTENT)).prompt).toBeUndefined()
  })
})
