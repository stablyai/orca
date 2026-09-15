import { describe, expect, it, vi } from 'vitest'
import type * as RuntimeCreateTerminalDependencies from './orca-runtime-create-terminal-dependencies'
import { buildRuntimeAgentTeamsLaunchPlan } from './orca-runtime-agent-teams-launch-plan'

vi.mock('./orca-runtime-create-terminal-dependencies', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeCreateTerminalDependencies>()
  return {
    ...actual,
    inferCapturedClaudeAgentTeamsMode: () => 'native-panes-shim',
    buildClaudeAgentTeamsLaunchPlan: vi.fn().mockResolvedValue({
      command: "claude --teammate-mode auto 'hello'",
      mode: 'native-panes-shim',
      env: { TMUX_PANE: '%1' }
    })
  }
})

describe('buildRuntimeAgentTeamsLaunchPlan', () => {
  it('rewrites the captured agentCommand to match the plan it actually selected, not the platform', async () => {
    const { effectiveLaunchConfig } = await buildRuntimeAgentTeamsLaunchPlan({
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} } as never,
      command: "claude 'hello'",
      baseEnv: {},
      adoptedBeforeLaunch: false,
      createTeamEnv: () => ({})
    })

    // Why: the mocked plan resolved to native panes (auto); a platform-keyed rewrite would
    // desync launchConfig.agentCommand from the PTY command the plan actually built.
    expect(effectiveLaunchConfig?.agentCommand).toBe('claude --teammate-mode auto')
  })
})
