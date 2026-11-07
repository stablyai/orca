import { describe, expect, it } from 'vitest'
import { attestedLaunchConfig, type PtyLaunchFacts } from './attested-launch-config'

const launchConfig = { agentArgs: '--dangerously-skip-permissions', agentEnv: { FOO: '1' } }
const process = { incarnationId: 'p1', launchIncarnationId: 'p1' }

describe('attestedLaunchConfig', () => {
  it('keeps a Claude agent teams launch note when its hook reports claude', () => {
    const pty: PtyLaunchFacts = {
      ...process,
      launchToken: 'token',
      launchAgent: 'claude-agent-teams',
      launchConfig
    }
    expect(attestedLaunchConfig(pty, 'claude')).toEqual(launchConfig)
  })

  it('gives a different agent typed into the pane no note', () => {
    const pty: PtyLaunchFacts = {
      ...process,
      launchToken: 'token',
      launchAgent: 'claude',
      launchConfig
    }
    expect(attestedLaunchConfig(pty, 'codex')).toBeUndefined()
  })
})
