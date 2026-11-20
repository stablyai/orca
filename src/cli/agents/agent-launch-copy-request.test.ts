import { expect, it } from 'vitest'
import { parseCliAgent, readCliAgentLaunch } from './agent-launch-request'

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
