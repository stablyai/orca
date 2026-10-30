import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING } from '../../shared/agent-launch-account-env'

const ACCOUNT_ENV = { CLAUDE_CONFIG_DIR: '/home/u/.orca/claude/a', CODEX_HOME: '/home/u/.codex-b' }

function harness(structured: boolean) {
  const createWorktree = vi.fn(async (args: { startupAgent: string | undefined }) => ({
    worktreeId: 'wt-new',
    connectionId: null,
    startupTerminalHandle: args.startupAgent ? 'term_agent_first' : undefined
  }))
  const createStructuredSession = vi.fn(async () => ({
    sessionId: 'sess-1',
    handle: 'handle_structured',
    fence: 4
  }))
  const createTerminalAgent = vi.fn(async () => ({ handle: 'term_1' }))
  const runtime = {
    requireStore: () => ({
      getSettings: () => (structured ? { experimentalNativeChat: true } : null)
    }),
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true })
  }
  return {
    createWorktree,
    createStructuredSession,
    createTerminalAgent,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the two runtime methods the executor reaches; a missing one throws.
        runtime: runtime as unknown as AgentLaunchExecution['runtime'],
        intent,
        surfaces: { createStructuredSession, createTerminalAgent },
        workspaces: { createWorktree }
      })
  }
}

describe('agent.launch account env', () => {
  it('passes the account env to a terminal agent in an existing workspace', async () => {
    const h = harness(false)
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7' },
      accountEnv: ACCOUNT_ENV
    })
    expect(h.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ accountEnv: ACCOUNT_ENV })
    )
    expect(result.warning).toBeUndefined()
  })

  it('passes it to the startup terminal of a worktree the launch creates', async () => {
    const h = harness(false)
    await h.run({
      agent: 'codex',
      target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
      accountEnv: ACCOUNT_ENV
    })
    expect(h.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startupAgent: 'codex', accountEnv: ACCOUNT_ENV })
    )
  })

  it('keeps a structured session on its host-derived home and warns', async () => {
    const h = harness(true)
    const result = await h.run({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'wt-7' },
      accountEnv: ACCOUNT_ENV
    })
    expect(result.outcome.kind).toBe('structured')
    expect(h.createStructuredSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ accountEnv: expect.anything() })
    )
    expect(result.warning).toBe(STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING)
  })

  it('adds no warning to a structured launch that carried none', async () => {
    const h = harness(true)
    const result = await h.run({ agent: 'claude', target: { kind: 'existing', worktree: 'wt-7' } })
    expect(result.warning).toBeUndefined()
  })
})
