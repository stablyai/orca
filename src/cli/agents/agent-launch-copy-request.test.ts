import { expect, it, vi } from 'vitest'
import { callAgentLaunch, parseCliAgent, readCliAgentLaunch } from './agent-launch-request'
import type { RuntimeClient } from '../runtime/client'

it('launches an agent copy as its base agent carrying the copy id', () => {
  const flags = new Map<string, string | boolean>([
    ['agent', 'claude.code-mode'],
    ['model', 'claude-haiku-4-5']
  ])
  const agent = parseCliAgent('claude.code-mode')
  expect(readCliAgentLaunch(flags, agent, { createsWorktree: false })).toEqual({
    agent: 'claude',
    sessionOptions: { model: 'claude-haiku-4-5', agentCopy: 'claude.code-mode' }
  })
  expect(() => parseCliAgent('nope.code-mode')).toThrow('Unknown TUI agent "nope.code-mode"')
})

it('refuses a copy launch on a host that cannot start copies, before calling it', async () => {
  const call = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal runs before any client method is used.
  const client = { call } as unknown as RuntimeClient
  await expect(
    callAgentLaunch(
      client,
      { agent: 'claude', sessionOptions: { agentCopy: 'claude.code-mode' } },
      { target: { kind: 'existing', worktree: 'id:wt' } },
      ['agent.launch.v2', 'agent.launch.local-presentation.v1']
    )
  ).rejects.toThrow('This Orca host cannot start agent copies.')
  expect(call).not.toHaveBeenCalled()
})
