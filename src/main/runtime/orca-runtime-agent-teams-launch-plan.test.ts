import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAgentTeamsLaunchPlan } from './claude-agent-teams-shim-env'

const { buildPlanMock } = vi.hoisted(() => ({ buildPlanMock: vi.fn() }))

vi.mock('./orca-runtime-create-terminal-dependencies', async () => ({
  ...(await import('../../shared/claude-agent-teams-tmux-compat')),
  inferCapturedClaudeAgentTeamsMode: () => 'native-panes-shim',
  buildClaudeAgentTeamsLaunchPlan: buildPlanMock
}))

import { buildRuntimeAgentTeamsLaunchPlan } from './orca-runtime-agent-teams-launch-plan'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('buildRuntimeAgentTeamsLaunchPlan', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it.each<[ClaudeAgentTeamsLaunchPlan['mode'], string]>([
    ['native-panes-shim', 'claude --teammate-mode auto'],
    ['in-process', 'claude --teammate-mode in-process']
  ])('relaunches a %s plan on Windows with the mode the plan chose', async (mode, expected) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    buildPlanMock.mockResolvedValueOnce({ mode, command: expected, env: {} })

    const { effectiveLaunchConfig } = await buildRuntimeAgentTeamsLaunchPlan({
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      command: 'claude',
      baseEnv: {},
      adoptedBeforeLaunch: false,
      createTeamEnv: () => ({})
    })

    expect(effectiveLaunchConfig?.agentCommand).toBe(expected)
  })
})
