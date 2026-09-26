import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-agent-teams-plan-test' } }))

const { buildRuntimeAgentTeamsLaunchPlan } = await import('./orca-runtime-agent-teams-launch-plan')

describe('buildRuntimeAgentTeamsLaunchPlan', () => {
  it('keeps an --account leader on in-process teammates instead of host-account panes', async () => {
    const createTeamEnv = vi.fn(() => ({ ORCA_AGENT_TEAMS_TEAM_ID: 'team-1' }))

    const result = await buildRuntimeAgentTeamsLaunchPlan({
      launch: { command: 'claude', claudeAccountId: 'acct-b' },
      claudeAgentTeamsMode: 'native-panes-shim',
      baseEnv: { ORCA_AGENT_TEAMS_SHIM_BIN: '/usr/local/bin/orca' },
      adoptedBeforeLaunch: false,
      createTeamEnv
    })

    expect(createTeamEnv).not.toHaveBeenCalled()
    expect(result.plan?.command).toContain('--teammate-mode in-process')
    expect(result.plan?.env).toEqual({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  })
})
