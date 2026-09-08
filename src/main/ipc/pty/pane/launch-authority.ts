import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'

const AGENT_LAUNCH_TOKEN_MAX_LENGTH = 128

export function admitRendererAgentLaunchAuthority(args: {
  launchToken: unknown
  spawnEnv: Record<string, string> | undefined
  launchAgent: unknown
  launchConfig: SleepingAgentLaunchConfig | undefined
  isReattach: boolean
  hasStablePaneOwner: boolean
  incarnationId: unknown
}): { launchToken: string; launchAgent: TuiAgent } | null {
  if (
    args.isReattach ||
    args.hasStablePaneOwner ||
    !args.launchConfig ||
    !isTuiAgent(args.launchAgent) ||
    !isPtyIncarnationId(args.incarnationId) ||
    typeof args.launchToken !== 'string' ||
    args.launchToken.length === 0 ||
    args.launchToken.length > AGENT_LAUNCH_TOKEN_MAX_LENGTH ||
    args.spawnEnv?.ORCA_AGENT_LAUNCH_TOKEN !== args.launchToken
  ) {
    return null
  }
  return { launchToken: args.launchToken, launchAgent: args.launchAgent }
}

export function admitProviderReattachLaunchIdentity(args: {
  isReattach?: boolean
  launchAgent?: unknown
  incarnationId?: unknown
}): { incarnationId: string; launchAgent: TuiAgent } | null {
  if (
    !args.isReattach ||
    !isTuiAgent(args.launchAgent) ||
    !isPtyIncarnationId(args.incarnationId)
  ) {
    return null
  }
  return { incarnationId: args.incarnationId, launchAgent: args.launchAgent }
}

export function shouldRefreshNativeClaudeAgentTeamsEnv(args: {
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  const capturedCommand = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  const capturedArgs = args.launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  return /(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)
}
