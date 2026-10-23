import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  type ClaudeAgentTeamsMode
} from '../../../../shared/claude-agent-teams-tmux-compat'
import { capturedLaunchRequestsIterm2Teammates } from '../../../ipc/pty/pane/launch-authority'
import type { ClaudeAgentTeamsService } from '../../claude-agent-teams-service'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { buildClaudeAgentTeamsLaunchPlan } from '../../claude-agent-teams-shim-env'
import { inferCapturedClaudeAgentTeamsMode } from '../../runtime-agent-launch-resolution'

export async function buildRuntimeAgentTeamsLaunchPlan(args: {
  launchConfig: TerminalCreateOptions['launchConfig']
  command?: string
  claudeAgentTeamsSourceCommand?: string
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  baseEnv: Record<string, string | undefined>
  adoptedBeforeLaunch:
    | boolean
    | Awaited<ReturnType<NonNullable<RuntimePtyController['adoptStablePane']>>>
    | undefined
  claudeAgentTeams: Pick<ClaudeAgentTeamsService, 'createLaunchEnv'>
  leaderHandle: string
}): Promise<{
  plan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
  sequencedStartupCommand?: string
  effectiveLaunchConfig: TerminalCreateOptions['launchConfig']
}> {
  const sourceCommand =
    args.claudeAgentTeamsSourceCommand?.trim() || args.command?.trim() || undefined
  const mode = inferCapturedClaudeAgentTeamsMode(
    args.launchConfig,
    sourceCommand,
    args.claudeAgentTeamsMode
  )
  const requestsIterm2 = capturedLaunchRequestsIterm2Teammates({
    command: sourceCommand,
    launchConfig: args.launchConfig
  })
  const plan = args.adoptedBeforeLaunch
    ? undefined
    : await buildClaudeAgentTeamsLaunchPlan({
        command: sourceCommand,
        mode,
        ...(requestsIterm2 ? { teammateMode: 'iterm2' as const } : {}),
        baseEnv: args.baseEnv,
        createTeamEnv: (shimDir, shimBin, it2) =>
          args.claudeAgentTeams.createLaunchEnv({
            leaderHandle: args.leaderHandle,
            baseEnv: args.baseEnv,
            shimDir,
            shimBin,
            ...(it2 ? { it2 } : {})
          }).env
      })
  const sequencedStartupCommand =
    plan && sourceCommand && args.command && sourceCommand !== args.command
      ? plan.command
      : undefined
  const withTeammateMode = (agentCommand: string): string => {
    // Why: an explicit iTerm2 request must not gain a competing `--teammate-mode auto`.
    if (requestsIterm2) {
      return agentCommand
    }
    return mode === 'in-process' || process.platform === 'win32'
      ? addClaudeTeammateModeInProcess(agentCommand)
      : addClaudeTeammateModeAuto(agentCommand)
  }
  const effectiveLaunchConfig =
    args.launchConfig && plan
      ? {
          ...args.launchConfig,
          agentCommand: args.launchConfig.agentCommand
            ? withTeammateMode(args.launchConfig.agentCommand)
            : plan.command,
          agentEnv: { ...args.launchConfig.agentEnv, ...plan.env }
        }
      : args.launchConfig
  return { plan, sequencedStartupCommand, effectiveLaunchConfig }
}
