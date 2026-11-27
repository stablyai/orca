import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  type ClaudeAgentTeamsMode
} from '../../../../shared/agent-launch/startup/claude-agent-teams-tmux-compat'
import type { TerminalCreateOptions } from './terminal-create-options'
import { buildClaudeAgentTeamsLaunchPlan } from './claude-agent-teams-shim-env'
import { inferCapturedClaudeAgentTeamsMode } from './runtime-agent-launch-resolution'
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'

export async function buildRuntimeAgentTeamsLaunchPlan(args: {
  launchConfig: TerminalCreateOptions['launchConfig']
  launchAgent?: TerminalCreateOptions['launchAgent']
  command?: string
  connectionId?: string | null
  claudeAgentTeamsSourceCommand?: string
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  baseEnv: Record<string, string | undefined>
  createTeamEnv: (shimDir: string, shimBin: string) => Record<string, string>
}): Promise<{
  plan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
  sequencedStartupCommand?: string
  effectiveLaunchConfig: TerminalCreateOptions['launchConfig']
}> {
  const sourceCommand = args.claudeAgentTeamsSourceCommand || args.command
  const pickerTeams =
    args.launchAgent === 'claude-agent-teams' && Boolean(args.launchConfig?.commandProvenance)
  const mode = inferCapturedClaudeAgentTeamsMode(
    args.launchConfig,
    sourceCommand,
    pickerTeams ? 'native-panes-shim' : args.claudeAgentTeamsMode
  )
  const plan =
    args.connectionId ||
    (pickerTeams && recognizeAgentLaunchCommand(sourceCommand)?.agent === 'claude-agent-teams')
      ? undefined
      : await buildClaudeAgentTeamsLaunchPlan({
          command: sourceCommand,
          pickerTeams,
          mode,
          baseEnv: args.baseEnv,
          createTeamEnv: args.createTeamEnv
        })
  const sequencedStartupCommand =
    plan && sourceCommand && args.command && sourceCommand !== args.command
      ? plan.command
      : undefined
  const effectiveLaunchConfig =
    args.launchConfig && plan
      ? {
          ...args.launchConfig,
          agentCommand: args.launchConfig.agentCommand
            ? (plan.env.ORCA_AGENT_TEAMS_TEAM_ID
                ? addClaudeTeammateModeAuto
                : addClaudeTeammateModeInProcess)(args.launchConfig.agentCommand)
            : plan.command,
          agentEnv: { ...args.launchConfig.agentEnv, ...plan.env }
        }
      : args.launchConfig
  return { plan, sequencedStartupCommand, effectiveLaunchConfig }
}
