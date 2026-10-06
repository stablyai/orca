// @ts-nocheck -- the launch-plan adapter is kept independent from the runtime mixin chain.
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  buildClaudeAgentTeamsLaunchPlan,
  inferCapturedClaudeAgentTeamsMode
} from './orca-runtime-create-terminal-dependencies'

export async function buildRuntimeAgentTeamsLaunchPlan(args: {
  launch: Pick<
    TerminalCreateOptions,
    'launchConfig' | 'command' | 'claudeAgentTeamsSourceCommand' | 'launchAgent'
  >
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  baseEnv: Record<string, string | undefined>
  adoptedBeforeLaunch: boolean
  createTeamEnv: (shimDir: string, shimBin: string) => Record<string, string>
}): Promise<{
  plan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
  sequencedStartupCommand?: string
  effectiveLaunchConfig: TerminalCreateOptions['launchConfig']
}> {
  const { launchConfig, command, launchAgent } = args.launch
  const sourceCommand =
    args.launch.claudeAgentTeamsSourceCommand?.trim() || command?.trim() || undefined
  const mode = inferCapturedClaudeAgentTeamsMode(
    launchConfig,
    sourceCommand,
    args.claudeAgentTeamsMode
  )
  const plan = args.adoptedBeforeLaunch
    ? undefined
    : await buildClaudeAgentTeamsLaunchPlan({
        command: sourceCommand,
        ...(launchAgent ? { launchAgent } : {}),
        mode,
        baseEnv: args.baseEnv,
        createTeamEnv: args.createTeamEnv
      })
  const sequencedStartupCommand =
    plan && sourceCommand && command && sourceCommand !== command ? plan.command : undefined
  const effectiveLaunchConfig =
    launchConfig && plan
      ? {
          ...launchConfig,
          agentCommand: launchConfig.agentCommand
            ? mode === 'in-process' || process.platform === 'win32'
              ? addClaudeTeammateModeInProcess(launchConfig.agentCommand)
              : addClaudeTeammateModeAuto(launchConfig.agentCommand)
            : plan.command,
          agentEnv: { ...launchConfig.agentEnv, ...plan.env }
        }
      : launchConfig
  return { plan, sequencedStartupCommand, effectiveLaunchConfig }
}
