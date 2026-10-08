// @ts-nocheck -- the launch-plan adapter is kept independent from the runtime mixin chain.
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess,
  buildClaudeAgentTeamsLaunchPlan,
  inferCapturedClaudeAgentTeamsMode
} from './orca-runtime-create-terminal-dependencies'

export async function buildRuntimeAgentTeamsLaunchPlan(input: {
  launch: Pick<
    TerminalCreateOptions,
    'launchConfig' | 'command' | 'claudeAgentTeamsSourceCommand' | 'claudeAccountId'
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
  const args = { ...input, ...input.launch }
  const sourceCommand =
    args.claudeAgentTeamsSourceCommand?.trim() || args.command?.trim() || undefined
  const capturedMode = inferCapturedClaudeAgentTeamsMode(
    args.launchConfig,
    sourceCommand,
    args.claudeAgentTeamsMode
  )
  // Why: native-pane teammates are separate terminals launched on the host's active account; an
  // `--account` leader keeps its teammates in-process, on its own pinned credentials.
  const mode =
    args.claudeAccountId && capturedMode === 'native-panes-shim' ? 'in-process' : capturedMode
  const plan = args.adoptedBeforeLaunch
    ? undefined
    : await buildClaudeAgentTeamsLaunchPlan({
        command: sourceCommand,
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
            ? mode === 'in-process' || process.platform === 'win32'
              ? addClaudeTeammateModeInProcess(args.launchConfig.agentCommand)
              : addClaudeTeammateModeAuto(args.launchConfig.agentCommand)
            : plan.command,
          agentEnv: { ...args.launchConfig.agentEnv, ...plan.env }
        }
      : args.launchConfig
  return { plan, sequencedStartupCommand, effectiveLaunchConfig }
}
