import { describe, expect, it } from 'vitest'
import type { AgentLaunchIntent } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { decideAgentLaunchIntentMode } from './agent-launch-intent-mode'

describe('agent copy launch mode', () => {
  const intent = (surface?: 'chat' | 'terminal'): AgentLaunchIntent => ({
    agent: 'claude',
    target: { kind: 'existing', worktree: 'id:w' },
    sessionOptions: { agentCopy: 'claude.code-mode' },
    ...(surface ? { surface } : {})
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a copy never reads the chat default, so the runtime is never consulted.
  const runtime = {} as Parameters<typeof decideAgentLaunchIntentMode>[0]['runtime']

  it('opens a copy in a terminal and says why', () => {
    expect(decideAgentLaunchIntentMode({ intent: intent(), runtime })).toMatchObject({
      mode: 'terminal',
      reason: 'agent_copy'
    })
  })

  it('refuses a chat asked for a copy before anything starts', () => {
    expect(() => decideAgentLaunchIntentMode({ intent: intent('chat'), runtime })).toThrow(
      "claude.code-mode can't open as a chat because agent copies open only in terminals"
    )
  })
})
