import { describe, expect, it } from 'vitest'
import { heldLaunchConfig, type PtyLaunchFacts } from './launch-evidence'

const config = { agentArgs: '--dangerously-skip-permissions', agentEnv: { FOO: '1' } }

function heldAs(agent: 'claude' | 'claude-agent-teams'): PtyLaunchFacts {
  return {
    incarnationId: 'p1',
    launchEvidence: { kind: 'held', incarnationId: 'p1', agent, token: 'token', config }
  }
}

describe('heldLaunchConfig', () => {
  it('keeps a Claude agent teams launch note when its hook reports claude', () => {
    expect(heldLaunchConfig(heldAs('claude-agent-teams'), 'claude')).toEqual(config)
  })

  it('gives a different agent typed into the pane no note', () => {
    expect(heldLaunchConfig(heldAs('claude'), 'codex')).toBeUndefined()
  })
})
