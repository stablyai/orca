import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { STRUCTURED_ACCOUNT_ENV_IGNORED_WARNING } from '../../shared/agent-launch/startup/agent-launch-account-env'

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
      getSettings: () => (structured ? { nativeChatProviders: EVERY_AGENT_CHAT } : null)
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
})
