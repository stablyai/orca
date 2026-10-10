import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { decideAgentLaunchMode } from './agent-launch-mode'
import { AgentLaunchStartupAgentNotCreatedError } from './agent-launch-legacy-host'
import type { AgentLaunchSurfaceFactory } from './agent-launch-surface-factories'

const getStructuredAgentSessionCreateSupport = vi.fn(async () => ({ supported: true }))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the two runtime methods the executor reaches; the chat default is on so a terminal-only launch is proven to ignore it.
const runtime = {
  getClientSettings: () => ({ experimentalNativeChat: true }),
  getStructuredAgentSessionCreateSupport
} as unknown as AgentLaunchExecution['runtime']

function workspaces(startupTerminalHandle: string | undefined) {
  return {
    createWorktree: vi.fn(async (_args: Record<string, unknown>) => ({
      worktreeId: 'wt-new',
      connectionId: null,
      startupTerminalHandle
    }))
  }
}

function legacyLaunch(
  agent: 'claude' | 'aider' | 'codex',
  prompt: { text: string; delivery: 'submit' | 'draft' } | undefined,
  factory = workspaces('term_agent')
) {
  return executeAgentLaunch({
    runtime,
    intent: {
      agent,
      target: { kind: 'create-worktree', create: { repo: 'repo-1' } },
      ...(prompt ? { prompt } : {})
    },
    terminalOnly: true,
    promptPolicy: 'legacy-host',
    workspaces: factory
  })
}

describe('terminal-only launches', () => {
  it('settle as a terminal whatever the chat default says', () => {
    expect(
      decideAgentLaunchMode({
        placement: { agent: 'claude', workspaceKind: 'git-worktree' },
        settings: { experimentalNativeChat: true },
        terminalOnly: true
      })
    ).toMatchObject({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default'
    })
  })
})

describe('the legacy-host prompt policy', () => {
  it('hands the whole text to the create and delivers nothing itself', async () => {
    const factory = workspaces('term_agent')

    const result = await legacyLaunch('aider', { text: 'fix the bug', delivery: 'submit' }, factory)

    const args = factory.createWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupAgent: 'aider',
      legacyPrompt: { text: 'fix the bug', delivery: 'submit' }
    })
    expect(args).not.toHaveProperty('startupPrompt')
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent' })
    expect(getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('reports a submit the launch command carried as handed to the terminal', async () => {
    const result = await legacyLaunch('claude', { text: 'fix the bug', delivery: 'submit' })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
  })

  it('reports a submit sent after the agent starts as unconfirmed, since the create does not await it', async () => {
    const result = await legacyLaunch('aider', { text: 'fix the bug', delivery: 'submit' })

    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'unconfirmed' })
  })

  it('reports a draft as never delivered by the host', async () => {
    const result = await legacyLaunch('codex', { text: 'https://x/1', delivery: 'draft' })

    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'not-delivered' })
  })

  it('reports no prompt when the launch carried none', async () => {
    const result = await legacyLaunch('claude', undefined)

    expect(result).not.toHaveProperty('prompt')
  })

  it('builds no second surface when the create started no agent', async () => {
    await expect(legacyLaunch('claude', undefined, workspaces(undefined))).rejects.toBeInstanceOf(
      AgentLaunchStartupAgentNotCreatedError
    )
  })

  it('applies only to a terminal-only create, refused before anything is created', async () => {
    const factory = workspaces('term_agent')
    await expect(
      // @ts-expect-error a legacy-host launch must create its workspace
      executeAgentLaunch({
        runtime,
        intent: { agent: 'claude', target: { kind: 'existing', worktree: 'w' } },
        terminalOnly: true,
        promptPolicy: 'legacy-host',
        workspaces: factory
      })
    ).rejects.toThrow('agent_launch_legacy_prompt_policy_requires_terminal_create')
    expect(factory.createWorktree).not.toHaveBeenCalled()
  })

  it('cannot be asked for without terminal-only, or alongside a surface factory', () => {
    const intent = {
      agent: 'claude' as const,
      target: { kind: 'create-worktree' as const, create: {} }
    }
    const factory = workspaces('t')
    const surfaces: AgentLaunchSurfaceFactory = {
      createStructuredSession: vi.fn(),
      createTerminalAgent: vi.fn()
    }
    const accepts = (execution: AgentLaunchExecution) => execution
    // @ts-expect-error legacy-host requires terminalOnly
    accepts({ runtime, intent, promptPolicy: 'legacy-host', workspaces: factory })
    // @ts-expect-error the create's startup terminal is a legacy-host launch's only surface
    accepts({
      runtime,
      intent,
      terminalOnly: true,
      promptPolicy: 'legacy-host',
      workspaces: factory,
      surfaces
    })
    // @ts-expect-error every other launch builds its own surface, so it must bring the factory
    accepts({ runtime, intent, workspaces: factory })
    expect(accepts({ runtime, intent, surfaces, workspaces: factory }).surfaces).toBe(surfaces)
  })
})
