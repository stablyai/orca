import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/workspace/identity/floating-workspace-id'
import { describe, expect, it } from 'vitest'
import { withAgentLaunchWorktreePolicy } from './agent-launch-worktree-policy'
import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'

describe('host launch worktree guidance', () => {
  const intent: AgentLaunchIntent = {
    agent: 'codex',
    target: { kind: 'create-worktree', create: { baseBranch: 'origin/release' } },
    prompt: { text: 'Fix it', delivery: 'draft' }
  }

  it('keeps draft delivery and original caller data, while attaching the baseline', () => {
    const launch = withAgentLaunchWorktreePolicy({ intent })
    expect(launch.intent.prompt?.delivery).toBe('draft')
    expect(launch.intent.prompt?.text).toContain('"origin/release"')
    expect(intent.prompt?.text).toBe('Fix it')
  })

  it('does not apply repository rules to a floating terminal', () => {
    const floating = {
      intent: {
        ...intent,
        target: { kind: 'existing' as const, worktree: FLOATING_TERMINAL_WORKTREE_ID }
      }
    }
    expect(withAgentLaunchWorktreePolicy(floating)).toBe(floating)
  })

  it('does not inject a second task into a reused terminal or a client-owned promptless launch', () => {
    const reuse = { intent: { ...intent, reuseTerminal: { handle: 'term_1' } } }
    expect(withAgentLaunchWorktreePolicy(reuse)).toBe(reuse)
    const promptless = { intent: { ...intent, prompt: undefined } }
    expect(withAgentLaunchWorktreePolicy(promptless)).toBe(promptless)
  })
})
